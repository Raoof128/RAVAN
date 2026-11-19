import type { Database } from "../../../../packages/db/src/open.js";
import {
  MAX_READING_BYTES,
  type ReadingPreparation,
} from "../../../../packages/contracts/src/reading.js";
import { JobQueue } from "../../../worker/src/leases.js";

export function readingPreparation(
  db: Database,
  id: string,
  generation: string,
  size: number,
): ReadingPreparation {
  const { bytes } = db
    .prepare(
      "SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM cache_blocks WHERE source_id=? AND generation=? AND state='ready'",
    )
    .get(id, generation) as { bytes: number };
  const job = db
    .prepare("SELECT state FROM jobs WHERE unique_key=?")
    .get(`reading:${id}:${generation}`) as { state: string } | undefined;
  return describePreparation(bytes, size, job?.state);
}
export function describePreparation(
  bytes: number,
  size: number,
  jobState?: string | null,
): ReadingPreparation {
  const state =
    bytes === size && size > 0
      ? "ready"
      : jobState === "running"
        ? "preparing"
        : jobState === "queued"
          ? "queued"
          : jobState === "failed"
            ? "failed"
            : "on-demand";
  return {
    state,
    percent: size > 0 ? Math.min(100, Math.floor((100 * bytes) / size)) : 0,
  };
}

export function queueReading(
  db: Database,
  id: string,
  generation: string,
  size: number,
) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_READING_BYTES)
    throw new Error("Invalid reading size");
  return db
    .transaction(() => {
      const status = readingPreparation(db, id, generation, size);
      if (status.state === "ready") return status;
      const queue = new JobQueue(db);
      const job = queue.enqueue(
        "reading",
        `reading:${id}:${generation}`,
        { fileId: id, generation, sizeBytes: String(size) },
        Date.now(),
      );
      // A completed job can be requested again after LRU eviction.
      db.prepare(
        "UPDATE jobs SET state='queued',attempts=0 WHERE id=? AND state='completed'",
      ).run(job);
      if (status.state === "failed") queue.retry(job);
      return readingPreparation(db, id, generation, size);
    })
    .immediate();
}
