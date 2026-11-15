import type { MediaFailureCode } from "./process.js";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../packages/db/src/open.js";
export type Job = {
  id: string;
  kind: string;
  payload: string;
  lease_until: number;
  attempts: number;
};
export class JobQueue {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  enqueue(kind: string, key: string, payload: unknown) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs(id,unique_key,kind,payload) VALUES(?,?,?,?)",
      )
      .run(id, key, kind, JSON.stringify(payload));
    return (
      this.db.prepare("SELECT id FROM jobs WHERE unique_key=?").get(key) as {
        id: string;
      }
    ).id;
  }
  claim(): Job | undefined {
    return this.db.transaction(() => {
      const now = this.now();
      if (
        this.db
          .prepare(
            "SELECT 1 FROM playback_sessions WHERE revoked_at IS NULL AND lease_until>?",
          )
          .get(now)
      )
        return;
      this.db
        .prepare(
          "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END WHERE state='running' AND lease_until<=?",
        )
        .run(now);
      if (this.db.prepare("SELECT 1 FROM jobs WHERE state='running'").get())
        return;
      const job = this.db
        .prepare(
          "SELECT * FROM jobs WHERE state='queued' AND attempts<3 ORDER BY rowid LIMIT 1",
        )
        .get() as Job | undefined;
      if (!job) return;
      const lease = now + 60000;
      this.db
        .prepare(
          "UPDATE jobs SET state='running',lease_until=?,attempts=attempts+1 WHERE id=?",
        )
        .run(lease, job.id);
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
  fail(job: Job, code: MediaFailureCode = "media_failed") {
    this.db
      .prepare(
        "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,lease_until=NULL,error_code=? WHERE id=? AND state='running' AND lease_until=?",
      )
      .run(code, job.id, job.lease_until);
  }
}
