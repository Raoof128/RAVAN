import { randomUUID } from "node:crypto";
import type { Database } from "../../../../packages/db/src/open.js";
import type { SourceRef } from "../../../../packages/contracts/src/index.js";
import {
  type DriveClient,
  type DriveFile,
  DriveError,
  driveId,
} from "./client.js";
import { belongsTo, folderMime, generation } from "./membership.js";
export function isVideoFile(file: Pick<DriveFile, "mimeType" | "name">) {
  // Some uploaders use generic MIME types for MKV/AVI. Probe the bytes before playback.
  return (
    file.mimeType.startsWith("video/") ||
    ([
      "application/octet-stream",
      "application/x-matroska",
      "application/mp4",
      "application/ogg",
    ].includes(file.mimeType) &&
      /\.(mp4|m4v|mkv|webm|mov|avi|wmv|asf|flv|mpg|mpeg|m2v|m2ts|mts|ts|vob|ogv|3gp|3g2|rm|rmvb|nut)$/i.test(
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
  start: string;
};
type Checkpoint = {
  folder_id: string;
  state: string;
  counts: string;
  token: string | null;
};
export class LibrarySync {
  private running?: Promise<Result>;
  private activeFolder?: string;
  constructor(
    private db: Database,
    private client: DriveClient,
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
  syncLibrary(folderId: string, signal: AbortSignal): Promise<Result> {
    driveId.parse(folderId);
    if (this.running) {
      if (this.activeFolder !== folderId)
        return Promise.reject(new Error("Scan in progress"));
      return this.running;
    }
    this.activeFolder = folderId;
    this.running = this.scan(folderId, signal).finally(() => {
      this.running = undefined;
      this.activeFolder = undefined;
    });
    return this.running;
  }
  private async changeCursor(start: string, signal: AbortSignal) {
    let token = start,
      changed = false;
    const seen = new Set<string>();
    for (let pages = 0; pages < 10000; pages++) {
      signal.throwIfAborted();
      if (seen.has(token)) throw new Error("Changes pagination loop");
      seen.add(token);
      const page = await this.client.changes(token, signal);
      changed ||= page.changed;
      if (!page.nextPageToken) {
        if (!page.newStartPageToken)
          throw new Error("Missing changes checkpoint");
        return { token: page.newStartPageToken, changed };
      }
      token = page.nextPageToken;
    }
    throw new Error("Changes page limit");
  }
  private async scan(root: string, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();
    let stage: Stage | undefined;
    try {
      const folder = await this.client.get(root, signal);
      if (folder.trashed || folder.mimeType !== folderMime)
        throw new Error("Select a folder");
      const saved = this.checkpoint();
      if (saved?.folder_id === root) {
        stage = (JSON.parse(saved.counts) as { stage?: Stage }).stage;
        if (stage && (await this.changeCursor(stage.start, signal)).changed)
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
            } else if (
              isVideoFile(file) &&
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
        const end = await this.changeCursor(stage.start, signal);
        if (end.changed) {
          stage = undefined;
          continue;
        }
        const result = this.publish(root, stage.files, end.token);
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
        try {
          await this.client.get(root, signal);
        } catch {
          this.db.transaction(() => {
            this.db.prepare("UPDATE source_files SET available=0").run();
            this.db
              .prepare(
                "UPDATE playback_sessions SET revoked_at=? WHERE revoked_at IS NULL",
              )
              .run(Date.now());
          })();
        }
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
  private publish(root: string, files: DriveFile[], token: string): Result {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE source_files SET available=0").run();
      for (const file of files) {
        const previous = this.db
          .prepare("SELECT movie_id,generation FROM source_files WHERE id=?")
          .get(file.id) as { movie_id: string; generation: string } | undefined;
        const movie = previous?.movie_id ?? randomUUID();
        const gen = generation(file);
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
      this.save(root, "succeeded", token, { result });
      return result;
    })();
  }
  async verifySource(fileId: string): Promise<SourceRef> {
    const row = this.db
      .prepare("SELECT generation,available FROM source_files WHERE id=?")
      .get(fileId) as { generation: string; available: number } | undefined;
    const root = this.checkpoint()?.folder_id;
    if (!row?.available || !root) throw new Error("Source unavailable");
    const signal = AbortSignal.timeout(30000);
    const file = await this.client.get(fileId, signal);
    const rootFile = await this.client.get(root, signal);
    if (
      rootFile.trashed ||
      file.capabilities?.canDownload === false ||
      generation(file) !== row.generation ||
      !(await belongsTo(this.client, file, root, signal))
    ) {
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE source_files SET available=0 WHERE id=?")
          .run(fileId);
        this.db
          .prepare(
            "UPDATE playback_sessions SET revoked_at=? WHERE source_id=? AND revoked_at IS NULL",
          )
          .run(Date.now(), fileId);
      })();
      throw new Error("Source changed or unavailable");
    }
    return { fileId, generation: row.generation, sizeBytes: file.size! };
  }
}
