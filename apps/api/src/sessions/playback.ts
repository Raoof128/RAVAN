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
import { owns, type Principal } from "./devices.js";
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
      options?: PlaybackOptions,
    ) => Promise<PlaybackPlan>,
    private now = Date.now,
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
        .prepare("SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL")
        .get(row.device_id)
    )
      return false;
    return true;
  }
  private wire(row: Row, ticket: string, startMs = 0): PlaybackSession {
    const asset = row.asset_id
      ? (this.db
          .prepare(
            "SELECT subtitles FROM prepared_assets WHERE id=? AND state='ready'",
          )
          .get(row.asset_id) as { subtitles: string } | undefined)
      : undefined;
    const captions = asset
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
      mediaUrl: `/media/s/${ticket}/${row.asset_id ? "video.mp4" : "raw"}`,
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
        "SELECT id FROM source_files WHERE movie_id=? AND available=1 ORDER BY id",
      )
      .all(movieId) as { id: string }[];
    if (sources.length !== 1)
      return {
        kind: "unsupported",
        reason: sources.length
          ? "Choose a single source edition before playing this film."
          : "This source is unavailable.",
      };
    const source = await this.verify(sources[0]!.id);
    const plan = await this.plan(source, profile, options);
    if (plan.mode === "unsupported")
      return {
        kind: "unsupported",
        reason: plan.reason ?? "Unsupported format.",
      };
    if (plan.mode === "prepare")
      return {
        kind: "preparing",
        jobId: plan.assetId,
        progress: plan.progress,
        reason: plan.reason,
      };
    return this.db.transaction(() => {
      const now = this.now();
      // The worker can evict between planning and this transaction. Never issue
      // a ticket to an artifact that has already been reclaimed.
      if (
        plan.mode === "prepared" &&
        !this.db
          .prepare(
            "SELECT 1 FROM prepared_assets WHERE id=? AND state='ready' AND source_id=? AND generation=?",
          )
          .get(plan.assetId, source.fileId, source.generation)
      )
        return {
          kind: "preparing" as const,
          jobId: plan.assetId,
          reason: "Preparing this edition again.",
        };
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
      const id = randomUUID(),
        ticket = secret();
      const epoch = (
        this.db
          .prepare("SELECT COALESCE(MAX(epoch),0)+1 n FROM playback_sessions")
          .get() as { n: number }
      ).n;
      this.db
        .prepare(
          "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,device_id,web_session_hash,epoch,lease_until,access_until,expires_at,asset_id,label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
          now + 300000,
          now + 21600000,
          plan.mode === "prepared" ? plan.assetId : null,
          plan.label ?? "Original",
        );
      this.tickets.set(id, ticket);
      return {
        kind: "ready" as const,
        session: this.wire(this.row(id)!, ticket, startMs),
      };
    })();
  }
  async heartbeat(id: string, who: Principal): Promise<PlaybackSession> {
    let row = this.row(id);
    if (!this.active(row) || !owns(row, who))
      throw new Error("Session expired");
    let renewed = false;
    if (row.access_until <= this.now() + 30000) {
      const source = await this.verify(row.source_id);
      if (source.generation !== row.generation)
        throw new Error("Source changed");
      renewed = true;
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
          renewed ? now + 300000 : row.access_until,
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
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
      !/^(raw|video\.mp4|subtitle-\d+\.vtt)$/.test(path)
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
          "SELECT source_id,generation,state,subtitles FROM prepared_assets WHERE id=?",
        )
        .get(row.asset_id) as
        | {
            source_id: string;
            generation: string;
            state: string;
            subtitles: string;
          }
        | undefined;
      if (
        !asset ||
        asset.state !== "ready" ||
        asset.source_id !== row.source_id ||
        asset.generation !== row.generation ||
        !(
          path === "video.mp4" ||
          (JSON.parse(asset.subtitles) as Array<{ file: string }>).some(
            (c) => c.file === path,
          )
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
      return "accepted";
    })();
  }
}
