import type { Database } from "../../../packages/db/src/open.js";
import {
  SOURCE_BLOCK_BYTES,
  type SourceRef,
} from "../../../packages/contracts/src/index.js";
import { MAX_READING_BYTES } from "../../../packages/contracts/src/reading.js";
import type { Job, JobQueue } from "./leases.js";

// Idle preparation has a bounded working set. An explicit open always has
// priority and may read the rest of the library on demand.
const BACKGROUND_READING_BYTES = 512 * 1024 * 1024;
/**
 * Blocks warmed at once. One at a time left a 100 MiB book waiting on 25 Drive
 * round trips in a row; a few in flight keep the link busy without crowding
 * the reader's own requests out of the API (it admits eight at once).
 */
export const READING_WARM_CONCURRENCY = 3;
export function planReading(db: Database, queue: JobQueue) {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM jobs WHERE kind='reading' AND state<>'running' AND NOT EXISTS
      (SELECT 1 FROM reading_items r WHERE r.id=json_extract(jobs.payload,'$.fileId')
       AND r.generation=json_extract(jobs.payload,'$.generation') AND r.available=1)`,
    ).run();
    if (
      db
        .prepare(
          "SELECT 1 FROM jobs WHERE kind='reading' AND state IN ('queued','running')",
        )
        .get()
    )
      return;
    const { bytes } = db
      .prepare(
        `SELECT COALESCE(SUM(c.size_bytes),0) AS bytes FROM cache_blocks c
      JOIN reading_items r ON r.id=c.source_id AND r.generation=c.generation
      WHERE c.state='ready' AND r.available=1`,
      )
      .get() as { bytes: number };
    const next = db
      .prepare(
        `SELECT id AS fileId,generation,size_bytes AS sizeBytes FROM reading_items r
      WHERE available=1 AND CAST(size_bytes AS INTEGER) BETWEEN 1 AND ?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.unique_key='reading:'||r.id||':'||r.generation)
      ORDER BY (section>0 OR fraction>0) DESC,name COLLATE NOCASE,id LIMIT 1`,
      )
      .get(Math.min(MAX_READING_BYTES, BACKGROUND_READING_BYTES - bytes)) as
      SourceRef | undefined;
    if (next)
      queue.enqueue(
        "reading",
        `reading:${next.fileId}:${next.generation}`,
        next,
      );
  }).immediate();
}
export async function prepareReading(
  db: Database,
  queue: JobQueue,
  job: Job,
  ref: SourceRef,
  signal: AbortSignal,
  warm: (index: number, signal: AbortSignal) => Promise<void>,
  concurrency = READING_WARM_CONCURRENCY,
) {
  const size = Number(ref.sizeBytes);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_READING_BYTES)
    throw new Error("Invalid book size");
  const count = Math.ceil(size / SOURCE_BLOCK_BYTES);
  const resident = db.prepare(
    "SELECT block_index,size_bytes FROM cache_blocks WHERE source_id=? AND generation=? AND state='ready'",
  );
  const available = db.prepare(
    "SELECT 1 FROM reading_items WHERE id=? AND generation=? AND available=1",
  );
  const update = db.prepare(
    "UPDATE jobs SET progress=? WHERE id=? AND state='running' AND lease_until=?",
  );
  // Opening a PDF or ZIP commonly needs both the header and the directory at
  // the end. Resume from durable cache rows, including blocks a reader fetched.
  const order = new Set([
    0,
    count - 1,
    ...Array.from({ length: count }, (_, i) => i),
  ]);
  // A failed block stops the others; the job is retried from the cache rows.
  const inner = new AbortController();
  const stop = () => inner.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const check = () => {
    if (failure) throw failure.error;
    signal.throwIfAborted();
  };
  try {
    for (const i of order) {
      check();
      if (!available.get(ref.fileId, ref.generation))
        throw new Error("Source changed");
      const blocks = resident.all(ref.fileId, ref.generation) as {
        block_index: number;
        size_bytes: number;
      }[];
      const bytes = blocks.reduce((sum, b) => sum + b.size_bytes, 0);
      if (
        !update.run(
          Math.min(99, Math.floor((100 * bytes) / size)),
          job.id,
          job.lease_until,
        ).changes
      )
        throw new Error("Lost job lease");
      if (blocks.some((b) => b.block_index === i)) continue;
      const task: Promise<void> = warm(i, inner.signal)
        .catch((error: unknown) => {
          failure ??= { error };
          inner.abort();
        })
        .finally(() => running.delete(task));
      running.add(task);
      if (running.size >= Math.max(1, concurrency)) await Promise.race(running);
    }
    await Promise.all(running);
    check();
  } finally {
    signal.removeEventListener("abort", stop);
    inner.abort();
    await Promise.allSettled(running);
  }
  db.transaction(() => {
    const blocks = resident.all(ref.fileId, ref.generation) as {
      size_bytes: number;
    }[];
    const bytes = blocks.reduce((sum, b) => sum + b.size_bytes, 0);
    // Do not record completion if another cache admission evicted a block
    // or Drive sync replaced the generation before this transaction.
    if (!available.get(ref.fileId, ref.generation) || bytes !== size)
      throw new Error("Book preparation interrupted");
    if (!update.run(100, job.id, job.lease_until).changes)
      throw new Error("Lost job lease");
    queue.complete(job);
  })();
}
