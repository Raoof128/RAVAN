import type { MediaFailureCode } from "./process.js";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../packages/db/src/open.js";
export type Job = {
  id: string;
  kind: string;
  payload: string;
  lease_until: number;
  attempts: number;
  priority: number;
};
/**
 * Probes take seconds and conversions take hours, so they run in separate lanes:
 * a film the viewer just opened is inspected at once instead of waiting behind
 * whatever conversion is running.
 */
export type Lane = "probe" | "prepare";
/** A failed job may be tried again on request once this long has passed. */
export const RETRY_COOLDOWN_MS = 600000;
/** A newer request must be this much newer to interrupt the running job. */
const YIELD_MARGIN_MS = 30000;
/** Work this close to finishing is cheaper to finish than to redo. */
const YIELD_PROGRESS_LIMIT = 90;
const lanes: Record<Lane, string> = {
  probe: "kind='probe'",
  prepare: "kind<>'probe'",
};
export class JobQueue {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  /**
   * `priority` is 0 for background work and the request time for work a viewer
   * is waiting on, so the most recently requested film is always next.
   */
  enqueue(kind: string, key: string, payload: unknown, priority = 0) {
    // Atomic: another process must never see the job without its priority.
    return this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO jobs(id,unique_key,kind,payload,priority) VALUES(?,?,?,?,?)",
        )
        .run(randomUUID(), key, kind, JSON.stringify(payload), priority);
      if (priority > 0)
        this.db
          .prepare(
            "UPDATE jobs SET priority=? WHERE unique_key=? AND priority<?",
          )
          .run(priority, key, priority);
      return (
        this.db.prepare("SELECT id FROM jobs WHERE unique_key=?").get(key) as {
          id: string;
        }
      ).id;
    })();
  }
  /** Without a lane, one job runs at a time; with one, one job per lane. */
  claim(lane?: Lane): Job | undefined {
    const only = lane ? ` AND ${lanes[lane]}` : "";
    return this.db.transaction(() => {
      const now = this.now();
      this.db
        .prepare(
          "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,failed_at=CASE WHEN attempts>=3 THEN ? ELSE failed_at END WHERE state='running' AND lease_until<=?",
        )
        .run(now, now);
      if (
        this.db.prepare(`SELECT 1 FROM jobs WHERE state='running'${only}`).get()
      )
        return;
      const job = this.db
        .prepare(
          `SELECT * FROM jobs WHERE state='queued' AND attempts<3${only} ORDER BY priority DESC,rowid LIMIT 1`,
        )
        .get() as Job | undefined;
      if (!job) return;
      const lease = now + 60000;
      this.db
        .prepare(
          // Every attempt starts over, so its progress and its clock do too.
          "UPDATE jobs SET state='running',lease_until=?,started_at=?,progress=0,attempts=attempts+1 WHERE id=?",
        )
        .run(lease, now, job.id);
      return { ...job, lease_until: lease, attempts: job.attempts + 1 };
    })();
  }
  renew(job: Job) {
    const lease = this.now() + 60000;
    const result = this.db
      .prepare(
        "UPDATE jobs SET lease_until=? WHERE id=? AND state='running' AND lease_until=?",
      )
      .run(lease, job.id, job.lease_until);
    if (!result.changes) throw new Error("Lost job lease");
    job.lease_until = lease;
  }
  complete(job: Job) {
    const result = this.db
      .prepare(
        "UPDATE jobs SET state='completed',lease_until=NULL,error_code=NULL WHERE id=? AND state='running' AND lease_until=?",
      )
      .run(job.id, job.lease_until);
    if (!result.changes) throw new Error("Lost job lease");
  }
  /** Return an interrupted job to the queue without charging it an attempt. */
  release(job: Job) {
    this.db
      .prepare(
        "UPDATE jobs SET state='queued',lease_until=NULL,attempts=MAX(attempts-1,0) WHERE id=? AND state='running' AND lease_until=?",
      )
      .run(job.id, job.lease_until);
  }
  fail(job: Job, code: MediaFailureCode = "media_failed") {
    this.db
      .prepare(
        "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,failed_at=CASE WHEN attempts>=3 THEN ? ELSE failed_at END,lease_until=NULL,error_code=? WHERE id=? AND state='running' AND lease_until=?",
      )
      .run(this.now(), code, job.id, job.lease_until);
  }
  /**
   * Give a failed job three fresh attempts. Only an explicit viewer request calls
   * this, and the cool-down keeps a film that cannot be converted from looping.
   */
  retry(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state='queued',attempts=0,progress=0,error_code=NULL,failed_at=NULL WHERE id=? AND state='failed' AND (failed_at IS NULL OR failed_at<=?)",
        )
        .run(id, this.now() - RETRY_COOLDOWN_MS).changes > 0
    );
  }
  /**
   * Whether the running job should make way: a viewer is waiting on a different
   * film, asked clearly later than this one was, and this one is not nearly done.
   */
  shouldYield(job: Job): boolean {
    const current = this.db
      .prepare("SELECT priority,progress FROM jobs WHERE id=?")
      .get(job.id) as { priority: number; progress: number } | undefined;
    if (!current || current.progress >= YIELD_PROGRESS_LIMIT) return false;
    // Someone is watching this edition as it is made; it is not background work.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM playback_sessions WHERE asset_id=(SELECT json_extract(payload,'$.id') FROM jobs WHERE id=?) AND revoked_at IS NULL AND lease_until>?",
        )
        .get(job.id, this.now())
    )
      return false;
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE state='queued' AND attempts<3 AND kind=? AND id<>? AND priority>?",
        )
        .get(job.kind, job.id, current.priority + YIELD_MARGIN_MS),
    );
  }
}
