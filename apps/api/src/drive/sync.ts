import { randomUUID } from "node:crypto";
import { readingFormat } from "../../../../packages/contracts/src/reading.js";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import type { SourceRef } from "../../../../packages/contracts/src/index.js";
import {
  type DriveClient,
  type DriveFile,
  DriveError,
  driveId,
} from "./client.js";
import {
  belongsTo,
  folderMime,
  generation,
  sameContent,
} from "./membership.js";
export function isVideoFile(file: Pick<DriveFile, "mimeType" | "name">) {
  // Some uploaders use generic MIME types for MKV/AVI. Probe the bytes before playback.
  return (
    file.mimeType.startsWith("video/") ||
    ([
      "application/octet-stream",
      "application/x-matroska",
      "application/mp4",
      "application/ogg",
      "application/mxf",
      "application/vnd.rn-realmedia",
      "application/vnd.rn-realmedia-vbr",
    ].includes(file.mimeType) &&
      /\.(mp4|m4v|mkv|mk3d|webm|mov|qt|avi|divx|xvid|wmv|asf|flv|f4v|mpg|mpeg|mpe|m1v|m2v|m2ts|m2t|mts|ts|tp|trp|vob|vro|mod|tod|ogv|ogm|3gp|3g2|rm|rmvb|nut|mxf|wtv|dv|ivf)$/i.test(
        file.name,
      ))
  );
}
type Result = { upserts: number; unavailable: number };
type Stage = {
  queue: string[];
  seen: string[];
  page?: string;
  pages: string[];
  files: DriveFile[];
  /** Every folder found below the root, so the library can be browsed by folder. */
  folders: LibraryFolder[];
  start: string;
};
type LibraryFolder = { id: string; name: string; parent: string };
type Checkpoint = {
  folder_id: string;
  state: string;
  counts: string;
  token: string | null;
};
/**
 * Whether a failed verification is a verdict on the source (gone, forbidden,
 * changed) rather than Drive being slow or unreachable. Only a verdict may end
 * what depends on the source; anything else is worth asking again.
 */
export function sourceGone(error: unknown): boolean {
  return (
    (error instanceof DriveError &&
      (error.status === 403 || error.status === 404)) ||
    (error instanceof Error &&
      /^Source (unavailable|changed or unavailable|metadata incomplete)$/.test(
        error.message,
      )) ||
    error instanceof z.ZodError
  );
}
/** How long one successful Drive verification may answer later non-fresh checks. */
export const VERIFY_REUSE_MS = 5000;
/** A scheduled refresh trusts the Drive change feed for at most this long. */
export const FULL_SCAN_INTERVAL_MS = 3600000;
type Verification = { at: number; root: string; promise: Promise<SourceRef> };
export class LibrarySync {
  private running?: Promise<Result>;
  private activeFolder?: string;
  private verified = new Map<string, Verification>();
  constructor(
    private db: Database,
    private client: DriveClient,
    private now = Date.now,
  ) {}
  status() {
    const row = this.checkpoint();
    if (!row) return { folderId: null, state: "idle", counts: {} };
    const data = JSON.parse(row.counts) as {
      stage?: Stage;
      result?: Result;
      error?: string;
    };
    return {
      folderId: row.folder_id,
      state: row.state,
      counts: data.result ?? {},
      ...(data.error ? { error: data.error } : {}),
    };
  }
  /**
   * Confirm a folder exists and is usable before it replaces the library's
   * checkpoint. A mistyped id otherwise displaces a working library and every
   * playback fails until it is corrected.
   */
  async checkFolder(folderId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const folder = await this.client.get(driveId.parse(folderId), signal);
      return !folder.trashed && folder.mimeType === folderMime;
    } catch (error) {
      if (
        error instanceof DriveError &&
        (error.status === 403 || error.status === 404)
      )
        return false;
      throw error;
    }
  }
  private checkpoint() {
    return this.db
      .prepare("SELECT * FROM sync_checkpoints WHERE id='library'")
      .get() as Checkpoint | undefined;
  }
  private save(
    root: string,
    state: string,
    token: string | null,
    data: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO sync_checkpoints(id,folder_id,state,token,counts) VALUES('library',?,?,?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,state=excluded.state,token=excluded.token,counts=excluded.counts",
      )
      .run(root, state, token, JSON.stringify(data));
  }
  /**
   * `incremental` is for the unattended schedule: when Drive reports no change
   * since the last complete scan, the published catalogue is already current and
   * the folder tree is not enumerated again. An owner-requested sync always scans.
   */
  syncLibrary(
    folderId: string,
    signal: AbortSignal,
    options: { incremental?: boolean } = {},
  ): Promise<Result> {
    driveId.parse(folderId);
    if (this.running) {
      if (this.activeFolder !== folderId)
        return Promise.reject(new Error("Scan in progress"));
      return this.running;
    }
    this.activeFolder = folderId;
    this.running = this.scan(
      folderId,
      signal,
      options.incremental ?? false,
    ).finally(() => {
      this.running = undefined;
      this.activeFolder = undefined;
    });
    return this.running;
  }
  /**
   * Files and folders whose change could alter the catalogue: every source ever
   * catalogued, every folder of the library, and anything now placed in one.
   */
  private concerns(folders: Iterable<string>, files: Iterable<string> = []) {
    const known = new Set<string>([...folders, ...files]);
    for (const row of this.db.prepare("SELECT id FROM source_files").all() as {
      id: string;
    }[])
      known.add(row.id);
    for (const row of this.db.prepare("SELECT id FROM reading_items").all() as {
      id: string;
    }[])
      known.add(row.id);
    return (item: { fileId: string; parents?: string[] }) =>
      !item.fileId ||
      known.has(item.fileId) ||
      Boolean(item.parents?.some((parent) => known.has(parent)));
  }
  private async changeCursor(
    start: string,
    signal: AbortSignal,
    concerns?: (item: { fileId: string; parents?: string[] }) => boolean,
  ) {
    let token = start,
      changed = false;
    const seen = new Set<string>();
    for (let pages = 0; pages < 10000; pages++) {
      signal.throwIfAborted();
      if (seen.has(token)) throw new Error("Changes pagination loop");
      seen.add(token);
      const page = await this.client.changes(token, signal);
      // An edit elsewhere in the owner's Drive is not a change to the library.
      changed ||=
        concerns && page.items ? page.items.some(concerns) : page.changed;
      if (!page.nextPageToken) {
        if (!page.newStartPageToken)
          throw new Error("Missing changes checkpoint");
        return { token: page.newStartPageToken, changed };
      }
      token = page.nextPageToken;
    }
    throw new Error("Changes page limit");
  }
  private async scan(
    root: string,
    signal: AbortSignal,
    incremental: boolean,
  ): Promise<Result> {
    signal.throwIfAborted();
    if (incremental) {
      const current = await this.unchanged(root, signal);
      if (current) return current;
    }
    let stage: Stage | undefined;
    try {
      const folder = await this.client.get(root, signal);
      if (folder.trashed || folder.mimeType !== folderMime)
        throw new Error("Select a folder");
      const saved = this.checkpoint();
      if (saved?.folder_id === root) {
        stage = (JSON.parse(saved.counts) as { stage?: Stage }).stage;
        // A scan saved before folders were recorded has lost the names of the
        // folders it already passed: start it again rather than publish a
        // library whose folders cannot be opened.
        if (stage && !stage.folders) stage = undefined;
        if (
          stage &&
          (
            await this.changeCursor(
              stage.start,
              signal,
              this.concerns(
                [...stage.seen, ...stage.queue],
                stage.files.map((f) => f.id),
              ),
            )
          ).changed
        )
          stage = undefined;
      }
      // Reconcile changes around the snapshot. Concurrent changes restart the scan;
      // incomplete pages never publish catalogue rows or advance the stable token.
      for (let restart = 0; restart < 3; restart++) {
        stage ??= {
          queue: [root],
          seen: [],
          pages: [],
          files: [],
          folders: [],
          start: await this.client.startToken(signal),
        };
        while (stage.queue.length) {
          signal.throwIfAborted();
          const parent = stage.queue[0]!;
          const pageKey = `${parent}:${stage.page ?? ""}`;
          if (stage.pages.includes(pageKey))
            throw new Error("Drive pagination loop");
          const page = await this.client.list(parent, stage.page, signal);
          const next: Stage = structuredClone(stage);
          next.pages.push(pageKey);
          for (const file of page.files) {
            if (file.trashed || !file.parents?.includes(parent)) continue;
            if (file.mimeType === folderMime) {
              if (!next.seen.includes(file.id) && !next.queue.includes(file.id))
                next.queue.push(file.id);
              if (
                file.id !== root &&
                !next.folders.some((f) => f.id === file.id)
              )
                next.folders.push({ id: file.id, name: file.name, parent });
            } else if (
              (isVideoFile(file) || readingFormat(file.name, file.mimeType)) &&
              file.mimeType !== "application/vnd.google-apps.shortcut" &&
              file.capabilities?.canDownload !== false
            ) {
              generation(file);
              if (!next.files.some((f) => f.id === file.id))
                next.files.push(file);
            }
          }
          if (next.files.length > 100000 || next.pages.length > 100000)
            throw new Error("Library scan limit");
          if (page.nextPageToken) next.page = page.nextPageToken;
          else {
            next.queue.shift();
            next.seen.push(parent);
            delete next.page;
          }
          this.db.transaction(() =>
            this.save(root, "running", saved?.token ?? null, { stage: next }),
          )();
          stage = next;
        }
        const end = await this.changeCursor(
          stage.start,
          signal,
          this.concerns(
            stage.seen,
            stage.files.map((f) => f.id),
          ),
        );
        if (end.changed) {
          stage = undefined;
          continue;
        }
        const result = this.publish(
          { id: root, name: folder.name, parent: "" },
          stage.files,
          end.token,
          stage.seen,
          stage.folders,
        );
        return result;
      }
      throw new Error("Library changed during scan; retry");
    } catch (error) {
      if (
        error instanceof DriveError &&
        (error.status === 403 || error.status === 404)
      ) {
        // Only a lost root invalidates the entire library; failed child pages remain
        // unpublished. Session creation always rechecks actual membership/access.
        // Only Google confirming the root is gone or forbidden closes the library.
        // A timeout, 5xx or shutdown during this lookup proves nothing.
        let rootLost = false;
        try {
          await this.client.get(root, signal);
        } catch (rootError) {
          rootLost =
            rootError instanceof DriveError &&
            (rootError.status === 403 || rootError.status === 404);
        }
        if (rootLost)
          this.db.transaction(() => {
            this.db.prepare("UPDATE source_files SET available=0").run();
            this.db.prepare("UPDATE reading_items SET available=0").run();
            this.db
              .prepare(
                "UPDATE playback_sessions SET revoked_at=? WHERE revoked_at IS NULL",
              )
              .run(Date.now());
          })();
      }
      const saved = this.checkpoint();
      this.save(root, "failed", saved?.token ?? null, {
        stage:
          saved?.folder_id === root
            ? (JSON.parse(saved.counts) as { stage?: Stage }).stage
            : undefined,
        error: "sync_failed",
      });
      throw error;
    }
  }
  /**
   * The published result, when Drive reports nothing changed since it was made.
   * This runs outside scan()'s failure handling on purpose: a transient error
   * here rejects and leaves the good checkpoint as it is, rather than recording
   * a failed scan and forcing the full enumeration this check exists to avoid.
   */
  private async unchanged(
    root: string,
    signal: AbortSignal,
  ): Promise<Result | undefined> {
    const saved = this.checkpoint();
    if (
      saved?.folder_id !== root ||
      saved.state !== "succeeded" ||
      !saved.token
    )
      return;
    const last = JSON.parse(saved.counts) as {
      result?: Result;
      scannedAt?: number;
      folders?: string[];
    };
    // A library published before folders were recorded is scanned once in full,
    // so that it can be browsed by folder without waiting for the hourly scan.
    const recorded = this.db
      .prepare("SELECT 1 FROM library_folders WHERE id=? AND parent_id IS NULL")
      .get(root);
    if (
      !recorded ||
      !last.result ||
      last.scannedAt === undefined ||
      this.now() - last.scannedAt >= FULL_SCAN_INTERVAL_MS
    )
      return;
    try {
      const folder = await this.client.get(root, signal);
      if (folder.trashed || folder.mimeType !== folderMime) return;
      const cursor = await this.changeCursor(
        saved.token,
        signal,
        // A checkpoint from before folders were recorded treats any change as relevant.
        last.folders ? this.concerns([root, ...last.folders]) : undefined,
      );
      if (cursor.changed) return;
      if (cursor.token !== saved.token)
        this.save(root, "succeeded", cursor.token, last);
      return last.result;
    } catch (error) {
      // A refusal (lost root, expired change token) will not fix itself: let the
      // full scan establish and record the real state.
      if (
        error instanceof DriveError &&
        error.status < 500 &&
        error.status !== 429
      )
        return;
      throw error;
    }
  }
  private publish(
    top: LibraryFolder,
    files: DriveFile[],
    token: string,
    folders: string[],
    named: LibraryFolder[],
  ): Result {
    const root = top.id;
    return this.db.transaction(() => {
      this.db.prepare("UPDATE source_files SET available=0").run();
      this.db.prepare("UPDATE reading_items SET available=0").run();
      // The folder tree is replaced whole, like the catalogue: a folder that
      // was removed or renamed in Drive is shown as Drive has it now.
      this.db.prepare("DELETE FROM library_folders").run();
      const addFolder = this.db.prepare(
        "INSERT OR IGNORE INTO library_folders(id,name,parent_id) VALUES(?,?,?)",
      );
      addFolder.run(root, top.name, null);
      for (const folder of named)
        addFolder.run(folder.id, folder.name, folder.parent);
      for (const file of files) {
        const format = readingFormat(file.name, file.mimeType);
        if (format) {
          const previous = this.db
            .prepare("SELECT generation,metadata FROM reading_items WHERE id=?")
            .get(file.id) as
            { generation: string; metadata: string } | undefined;
          const gen =
            previous && sameContent(previous.metadata, file)
              ? previous.generation
              : generation(file);
          this.db
            .prepare(
              `INSERT INTO reading_items(id,name,format,generation,size_bytes,metadata)
            VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,format=excluded.format,size_bytes=excluded.size_bytes,
            metadata=excluded.metadata,available=1,
            section=CASE WHEN generation=excluded.generation THEN section ELSE 0 END,
            fraction=CASE WHEN generation=excluded.generation THEN fraction ELSE 0 END,
            generation=excluded.generation`,
            )
            .run(
              file.id,
              file.name,
              format,
              gen,
              file.size!,
              JSON.stringify(file),
            );
          continue;
        }
        const previous = this.db
          .prepare(
            "SELECT movie_id,generation,metadata FROM source_files WHERE id=?",
          )
          .get(file.id) as
          | { movie_id: string; generation: string; metadata: string }
          | undefined;
        const movie = previous?.movie_id ?? randomUUID();
        // The same bytes keep their generation, so what was prepared from
        // them stays valid; only a real change of content starts afresh.
        const gen =
          previous && sameContent(previous.metadata, file)
            ? previous.generation
            : generation(file);
        if (!previous)
          this.db
            .prepare("INSERT INTO movies(id,title) VALUES(?,?)")
            .run(movie, file.name.replace(/\.[^.]+$/, ""));
        this.db
          .prepare(
            "INSERT INTO source_files(id,movie_id,generation,size_bytes,name,parent_id,mime_type,metadata,available) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,size_bytes=excluded.size_bytes,name=excluded.name,parent_id=excluded.parent_id,mime_type=excluded.mime_type,metadata=excluded.metadata,available=1",
          )
          .run(
            file.id,
            movie,
            gen,
            file.size!,
            file.name,
            file.parents?.[0] ?? null,
            file.mimeType,
            JSON.stringify(file),
          );
        this.db
          .prepare(
            "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES(?,?,?,'Original',?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation",
          )
          .run(`source-${file.id}`, movie, file.id, gen);
      }
      this.db
        .prepare(
          "UPDATE playback_sessions SET revoked_at=? WHERE revoked_at IS NULL AND EXISTS(SELECT 1 FROM source_files s WHERE s.id=playback_sessions.source_id AND (s.available=0 OR s.generation<>playback_sessions.generation))",
        )
        .run(Date.now());
      const unavailable = (
        this.db
          .prepare("SELECT COUNT(*) n FROM source_files WHERE available=0")
          .get() as { n: number }
      ).n;
      const result = { upserts: files.length, unavailable };
      this.save(root, "succeeded", token, {
        result,
        scannedAt: this.now(),
        folders,
      });
      return result;
    })();
  }
  /**
   * Confirm with Drive that a source is still the catalogued generation inside the
   * selected folder. Local state is checked on every call. The Drive answer may be
   * reused for VERIFY_REUSE_MS: streaming asked three times per 4 MiB block, which
   * made metadata lookups, not bytes, the limit on throughput. Pass `fresh` when
   * the answer must postdate something just read from Drive.
   */
  async verifySource(fileId: string, fresh = false): Promise<SourceRef> {
    const row = this.db
      .prepare("SELECT generation,available FROM source_files WHERE id=?")
      .get(fileId) as { generation: string; available: number } | undefined;
    const root = this.checkpoint()?.folder_id;
    if (!row?.available || !root) throw new Error("Source unavailable");
    const recent = this.verified.get(fileId);
    if (
      !fresh &&
      recent &&
      recent.root === root &&
      this.now() - recent.at < VERIFY_REUSE_MS
    ) {
      const ref = await recent.promise;
      if (ref.generation === row.generation) return ref;
    }
    if (this.verified.size > 256)
      for (const [id, entry] of this.verified)
        if (this.now() - entry.at >= VERIFY_REUSE_MS) this.verified.delete(id);
    const entry: Verification = {
      at: this.now(),
      root,
      promise: this.verifyRemote(fileId, row.generation, root),
    };
    this.verified.set(fileId, entry);
    try {
      return await entry.promise;
    } catch (error) {
      // Never let a failed or stale answer satisfy a later caller.
      if (this.verified.get(fileId) === entry) this.verified.delete(fileId);
      throw error;
    }
  }
  /** Books use the same live folder/access boundary, but never enter video jobs. */
  async verifyReading(fileId: string): Promise<SourceRef> {
    driveId.parse(fileId);
    const row = this.db
      .prepare(
        "SELECT generation,metadata,available FROM reading_items WHERE id=?",
      )
      .get(fileId) as
      { generation: string; metadata: string; available: number } | undefined;
    const root = this.checkpoint()?.folder_id;
    if (!row?.available || !root) throw new Error("Source unavailable");
    const signal = AbortSignal.timeout(30000);
    const [file, folder] = await Promise.all([
      this.client.get(fileId, signal),
      this.client.get(root, signal),
    ]);
    if (
      folder.trashed ||
      folder.mimeType !== folderMime ||
      file.capabilities?.canDownload === false ||
      !sameContent(row.metadata, file) ||
      !(await belongsTo(this.client, file, root, signal))
    )
      throw new Error("Source changed or unavailable");
    // A folder switch or sync can finish while the remote checks are in flight.
    const current = this.db
      .prepare("SELECT generation,available FROM reading_items WHERE id=?")
      .get(fileId) as { generation: string; available: number } | undefined;
    if (
      this.checkpoint()?.folder_id !== root ||
      !current?.available ||
      current.generation !== row.generation
    )
      throw new Error("Source changed or unavailable");
    return { fileId, generation: row.generation, sizeBytes: file.size! };
  }
  /** Whether Drive's answer is still the content catalogued as `expected`. */
  private sameGeneration(fileId: string, expected: string, file: DriveFile) {
    const stored = this.db
      .prepare("SELECT metadata FROM source_files WHERE id=? AND generation=?")
      .get(fileId, expected) as { metadata: string } | undefined;
    return stored
      ? sameContent(stored.metadata, file)
      : generation(file) === expected;
  }
  private async verifyRemote(
    fileId: string,
    expected: string,
    root: string,
  ): Promise<SourceRef> {
    const signal = AbortSignal.timeout(30000);
    const [file, rootFile] = await Promise.all([
      this.client.get(fileId, signal),
      this.client.get(root, signal),
    ]);
    if (
      rootFile.trashed ||
      file.capabilities?.canDownload === false ||
      !this.sameGeneration(fileId, expected, file) ||
      !(await belongsTo(this.client, file, root, signal))
    ) {
      // Only condemn the generation this check was asked about. A scan may have
      // published a newer one while Drive was answering; closing that row would
      // hide a good source until the next full scan.
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE source_files SET available=0 WHERE id=? AND generation=?",
          )
          .run(fileId, expected);
        this.db
          .prepare(
            "UPDATE playback_sessions SET revoked_at=? WHERE source_id=? AND generation=? AND revoked_at IS NULL",
          )
          .run(Date.now(), fileId, expected);
      })();
      throw new Error("Source changed or unavailable");
    }
    return { fileId, generation: expected, sizeBytes: file.size! };
  }
}
