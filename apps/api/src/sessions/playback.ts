import { rememberPreparation } from "../media/native-preparations.js";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../../packages/db/src/open.js";
import type {
  SourceRef,
  PlaybackPlan,
  PlaybackResult,
  PlaybackSession,
  ProgressEvent,
  PlaybackOptions,
} from "../../../../packages/contracts/src/index.js";
import { hash, secret } from "../auth/sessions.js";
import { sourceGone } from "../drive/sync.js";
import { owns, type Principal } from "./devices.js";
import { HLS_FILE, HLS_PLAYLIST } from "../../../worker/src/hls.js";
/**
 * Access to a source lasts five minutes and is renewed by the player's
 * heartbeats, which come every 30 seconds. Renewal starts at half-time, so a
 * Drive lookup that fails has several heartbeats in which to succeed.
 */
const ACCESS_MS = 300000;
const RENEW_AHEAD_MS = ACCESS_MS / 2;
/** Within this of the end there is no later heartbeat: a failure is final. */
const LAST_CHANCE_MS = 30000;
type Row = {
  id: string;
  movie_id: string;
  source_id: string;
  generation: string;
  epoch: number;
  lease_until: number;
  access_until: number;
  expires_at: number;
  revoked_at: number | null;
  web_session_hash: string | null;
  device_id: string | null;
  edition_id: string | null;
  ticket_hash: string;
  asset_id: string | null;
  label: string;
};
export class PlaybackService {
  private tickets = new Map<string, string>();
  constructor(
    private db: Database,
    private verify: (id: string) => Promise<SourceRef>,
    private plan: (
      source: SourceRef,
      profile: string,
      options?: PlaybackOptions & { startMs?: number; screen?: boolean },
    ) => Promise<PlaybackPlan>,
    private now = Date.now,
    /**
     * How long a heartbeat waits for Drive. The player gives a heartbeat 15
     * seconds and the edge 20, while a Drive lookup may take 30: an answer
     * that arrives after the player stopped waiting is a failure to it.
     */
    private renewWaitMs = 8000,
  ) {}
  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM playback_sessions WHERE id=?")
      .get(id) as Row | undefined;
  }
  private active(row: Row | undefined): row is Row {
    if (
      !row ||
      row.revoked_at !== null ||
      row.lease_until <= this.now() ||
      row.expires_at <= this.now()
    )
      return false;
    if (
      row.device_id &&
      !this.db
        .prepare(
          "SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL AND awaiting_ack=0",
        )
        .get(row.device_id)
    )
      return false;
    return true;
  }
  private wire(row: Row, ticket: string, startMs = 0): PlaybackSession {
    const asset = row.asset_id
      ? (this.db
          .prepare(
            // The layout is read whatever the state: a withdrawn edition must
            // not make the address flip to the other layout's file.
            "SELECT subtitles,format,state FROM prepared_assets WHERE id=?",
          )
          .get(row.asset_id) as
          { subtitles: string; format: string; state: string } | undefined)
      : undefined;
    // Captions are complete only once the whole edition is; until then the
    // player is told on a later heartbeat.
    const captions =
      asset?.state === "ready"
        ? (JSON.parse(asset.subtitles) as Array<{
            file: string;
            language: string;
            label: string;
          }>)
        : [];
    return {
      label: row.label,
      subtitles: captions
        .filter((c) => /^subtitle-\d+\.vtt$/.test(c.file))
        .map((c) => ({
          url: `/media/s/${ticket}/${c.file}`,
          language: c.language,
          label: c.label,
        })),
      id: row.id,
      epoch: row.epoch,
      mediaUrl: `/media/s/${ticket}/${
        !row.asset_id
          ? "raw"
          : asset?.format === "hls"
            ? HLS_PLAYLIST
            : "video.mp4"
      }`,
      expiresAt: new Date(row.expires_at).toISOString(),
      startMs,
    };
  }
  async create(
    movieId: string,
    profile: string,
    startMs: number,
    who: Principal,
    replace?: string,
    options?: PlaybackOptions,
  ): Promise<PlaybackResult> {
    const sources = this.db
      .prepare(
        `SELECT s.id,s.generation,e.id editionId FROM source_files s
      LEFT JOIN editions e ON e.source_id=s.id AND e.movie_id=s.movie_id AND e.generation=s.generation
      WHERE s.movie_id=? AND s.available=1 AND (? IS NULL OR e.id=?) AND (? IS NULL OR s.generation=?) ORDER BY s.id`,
      )
      .all(
        movieId,
        options?.editionId ?? null,
        options?.editionId ?? null,
        options?.generation ?? null,
        options?.generation ?? null,
      ) as Array<{ id: string; generation: string; editionId: string | null }>;
    if (sources.length !== 1)
      return {
        kind: "unsupported",
        reason: sources.length
          ? "Choose a single source edition before playing this film."
          : "This source is unavailable.",
      };
    const source = await this.verify(sources[0]!.id);
    if (source.generation !== sources[0]!.generation)
      return {
        kind: "unsupported",
        reason: "This edition has changed. Refresh the film.",
      };
    const plan = await this.plan(source, profile, {
      ...options,
      startMs,
      // A screen is bounded in the work it may ask for; see the planner.
      screen: Boolean(who.deviceId),
    });
    if (plan.mode === "unsupported")
      return {
        kind: "unsupported",
        reason: plan.reason ?? "Unsupported format.",
      };
    const preparing = (
      jobId: string,
      reason?: string,
      phase = plan.phase,
    ): PlaybackResult => ({
      kind: "preparing",
      jobId,
      reason,
      phase,
      progress: plan.progress,
      ...(profile === "apple-sdr-v1" && sources[0]!.editionId
        ? {
            preparationId: rememberPreparation(
              this.db,
              who,
              movieId,
              sources[0]!.editionId,
              source,
              options ?? {},
              jobId,
            ),
          }
        : {}),
    });
    return this.db.transaction(() => {
      // Verification and planning can yield while the film is reassigned or the screen is revoked.
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM source_files WHERE id=? AND movie_id=? AND generation=? AND available=1",
          )
          .get(source.fileId, movieId, source.generation) ||
        (who.deviceId &&
          !this.db
            .prepare(
              "SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL AND awaiting_ack=0",
            )
            .get(who.deviceId))
      )
        return {
          kind: "unsupported" as const,
          reason: "This source or device is unavailable.",
        };
      if (plan.mode === "prepare") return preparing(plan.assetId, plan.reason);
      const now = this.now();
      // The worker can evict between planning and this transaction. Never issue
      // a ticket to an artifact that has already been reclaimed.
      if (
        plan.mode === "prepared" &&
        !this.db
          .prepare(
            "SELECT 1 FROM prepared_assets WHERE id=? AND state IN ('ready','streaming') AND source_id=? AND generation=?",
          )
          .get(plan.assetId, source.fileId, source.generation)
      )
        return preparing(
          (
            this.db
              .prepare("SELECT id FROM jobs WHERE unique_key=?")
              .get("browser:" + plan.assetId) as { id: string } | undefined
          )?.id ?? plan.assetId,
          "Preparing this edition again.",
          "retrying",
        );
      const previous = this.db
        .prepare(
          "SELECT * FROM playback_sessions WHERE revoked_at IS NULL AND lease_until>? AND expires_at>? LIMIT 1",
        )
        .get(now, now) as Row | undefined;
      if (previous && previous.id !== replace)
        return { kind: "conflict" as const, sessionId: previous.id };
      if (previous) {
        this.db
          .prepare("UPDATE playback_sessions SET revoked_at=? WHERE id=?")
          .run(now, previous.id);
        this.tickets.delete(previous.id);
      }
      // No other session is live at this point, so no other ticket is either.
      this.tickets.clear();
      const id = randomUUID(),
        ticket = secret();
      const epoch = (
        this.db
          .prepare("SELECT COALESCE(MAX(epoch),0)+1 n FROM playback_sessions")
          .get() as { n: number }
      ).n;
      this.db
        .prepare(
          "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,device_id,web_session_hash,epoch,lease_until,access_until,expires_at,asset_id,label,edition_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          hash(ticket),
          movieId,
          source.fileId,
          source.generation,
          who.deviceId ?? null,
          who.webHash ?? null,
          epoch,
          now + 120000,
          now + ACCESS_MS,
          now + 21600000,
          plan.mode === "prepared" ? plan.assetId : null,
          plan.label ?? "Original",
          sources[0]!.editionId,
        );
      this.tickets.set(id, ticket);
      return {
        kind: "ready" as const,
        session: this.wire(this.row(id)!, ticket, startMs),
      };
    })();
  }
  /**
   * Drive's confirmation, or a failure once the player would stop waiting. The
   * lookup itself carries on and can answer the next heartbeat.
   */
  private async confirm(sourceId: string): Promise<SourceRef> {
    const lookup = this.verify(sourceId);
    // It may lose the race below; its failure is then nobody's to handle.
    lookup.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        lookup,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Confirmation slow")),
            this.renewWaitMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async heartbeat(id: string, who: Principal): Promise<PlaybackSession> {
    let row = this.row(id);
    if (!this.active(row) || !owns(row, who))
      throw new Error("Session expired");
    let renewed = false;
    if (row.access_until <= this.now() + RENEW_AHEAD_MS) {
      let source: SourceRef | undefined;
      try {
        source = await this.confirm(row.source_id);
      } catch (error) {
        // A verdict on the film ends the session. Drive being slow or briefly
        // unreachable does not, while another heartbeat is still due before
        // access runs out: one failed lookup used to stop the film.
        if (
          sourceGone(error) ||
          row.access_until <= this.now() + LAST_CHANCE_MS
        )
          throw error;
      }
      if (source) {
        if (source.generation !== row.generation)
          throw new Error("Source changed");
        renewed = true;
      }
    }
    return this.db.transaction(() => {
      row = this.row(id);
      if (!this.active(row) || !owns(row, who))
        throw new Error("Session expired");
      let ticket = this.tickets.get(id);
      const now = this.now();
      if (!ticket || row.expires_at <= now + 60000) {
        this.db
          .prepare("INSERT OR REPLACE INTO media_ticket_grace VALUES(?,?,?)")
          .run(row.ticket_hash, id, Math.min(row.expires_at, now + 30000));
        ticket = secret();
        row.ticket_hash = hash(ticket);
        row.expires_at = now + 21600000;
        this.tickets.set(id, ticket);
      }
      this.db
        .prepare(
          "UPDATE playback_sessions SET ticket_hash=?,expires_at=?,lease_until=?,access_until=? WHERE id=?",
        )
        .run(
          row.ticket_hash,
          row.expires_at,
          now + 120000,
          renewed ? now + ACCESS_MS : row.access_until,
          id,
        );
      this.db
        .prepare("DELETE FROM media_ticket_grace WHERE expires_at<=?")
        .run(now);
      return this.wire(row, ticket);
    })();
  }
  async authorizeMedia(
    ticket: string,
    path: string,
  ): Promise<SourceRef & { assetId?: string }> {
    // Every name an edition may hold, in either layout. This list once named
    // only the one-language layout's files, so an all-languages edition could
    // be planned, prepared and offered, and then never played.
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
      !(
        /^(raw|video\.mp4|subtitle-\d+\.vtt)$/.test(path) || HLS_FILE.test(path)
      )
    )
      throw new Error("Media denied");
    const digest = hash(ticket);
    const row = this.db
      .prepare(
        "SELECT * FROM playback_sessions WHERE ticket_hash=? OR id=(SELECT session_id FROM media_ticket_grace WHERE ticket_hash=? AND expires_at>?)",
      )
      .get(digest, digest, this.now()) as Row | undefined;
    if (!this.active(row) || row.access_until <= this.now())
      throw new Error("Media denied");
    const source = this.db
      .prepare(
        "SELECT size_bytes,generation,available FROM source_files WHERE id=?",
      )
      .get(row.source_id) as
      { size_bytes: string; generation: string; available: number } | undefined;
    if (!source?.available || source.generation !== row.generation)
      throw new Error("Media denied");
    if (row.asset_id) {
      const asset = this.db
        .prepare(
          "SELECT source_id,generation,state,subtitles,format FROM prepared_assets WHERE id=?",
        )
        .get(row.asset_id) as
        | {
            source_id: string;
            generation: string;
            state: string;
            subtitles: string;
            format: string;
          }
        | undefined;
      // An edition may be watched while it is still being written, but only the
      // files of its own layout, and its captions only once they are complete.
      if (
        !asset ||
        (asset.state !== "ready" && asset.state !== "streaming") ||
        asset.source_id !== row.source_id ||
        asset.generation !== row.generation ||
        !(
          (asset.format === "hls"
            ? HLS_FILE.test(path)
            : path === "video.mp4") ||
          (asset.state === "ready" &&
            (JSON.parse(asset.subtitles) as Array<{ file: string }>).some(
              (c) => c.file === path,
            ))
        )
      )
        throw new Error("Media denied");
      return {
        fileId: row.source_id,
        generation: row.generation,
        sizeBytes: source.size_bytes,
        assetId: row.asset_id,
      };
    }
    if (path !== "raw") throw new Error("Media denied");
    return {
      fileId: row.source_id,
      generation: row.generation,
      sizeBytes: source.size_bytes,
    };
  }
  stop(id: string, who: Principal) {
    const row = this.row(id);
    if (row && owns(row, who)) {
      this.db
        .prepare("UPDATE playback_sessions SET revoked_at=? WHERE id=?")
        .run(this.now(), id);
      this.tickets.delete(id);
    }
  }
  recordProgress(event: ProgressEvent, who: Principal): "accepted" | "stale" {
    return this.db.transaction(() => {
      const row = this.row(event.sessionId);
      if (!this.active(row) || !owns(row, who) || row.epoch !== event.epoch)
        return "stale";
      const old = this.db
        .prepare("SELECT epoch,sequence FROM progress WHERE movie_id=?")
        .get(row.movie_id) as { epoch: number; sequence: number } | undefined;
      if (
        old &&
        (old.epoch > event.epoch ||
          (old.epoch === event.epoch && old.sequence >= event.sequence))
      )
        return "stale";
      this.db
        .prepare(
          "INSERT INTO progress VALUES(?,?,?,?,?,?,?) ON CONFLICT(movie_id) DO UPDATE SET session_id=excluded.session_id,epoch=excluded.epoch,sequence=excluded.sequence,position_ms=excluded.position_ms,ended=excluded.ended,updated_at=excluded.updated_at",
        )
        .run(
          row.movie_id,
          event.sessionId,
          event.epoch,
          event.sequence,
          event.positionMs,
          event.ended ? 1 : 0,
          this.now(),
        );
      this.db
        .prepare("DELETE FROM progress_editions WHERE movie_id=?")
        .run(row.movie_id);
      if (row.edition_id)
        this.db
          .prepare(
            "INSERT INTO progress_editions(movie_id,edition_id,generation) VALUES(?,?,?)",
          )
          .run(row.movie_id, row.edition_id, row.generation);
      return "accepted";
    })();
  }
}
