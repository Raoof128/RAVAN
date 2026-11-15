import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function database() {
  const dir = await mkdtemp(join(tmpdir(), "mov-worker-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}
const source = {
  fileId: "file",
  generation: "a".repeat(64),
  sizeBytes: "10",
};
const row = (db: Awaited<ReturnType<typeof database>>) =>
  db.prepare("SELECT state,attempts,lease_until FROM jobs").get() as {
    state: string;
    attempts: number;
    lease_until: number | null;
  };

it("a service stop returns the job to the queue without spending one of its attempts", async () => {
  const db = await database();
  new JobQueue(db).enqueue("probe", "probe:file", source);
  const worker = new MediaWorker(db, "http://127.0.0.1:9", "b".repeat(64));
  // Each deploy or restart stops the worker; a long conversion must survive more than three.
  for (let restart = 0; restart < 5; restart++) {
    const stopping = new AbortController();
    stopping.abort();
    expect(await worker.runNextJob(stopping.signal)).toBe("retry");
    expect(row(db)).toEqual({
      state: "queued",
      attempts: 0,
      lease_until: null,
    });
  }
});

it("a genuine failure still spends an attempt and stops after three", async () => {
  const db = await database();
  new JobQueue(db).enqueue("unknown-kind", "unknown", source);
  const worker = new MediaWorker(db, "http://127.0.0.1:9", "b".repeat(64));
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await worker.runNextJob(new AbortController().signal)).toBe("retry");
    expect(row(db)).toMatchObject({
      state: attempt === 3 ? "failed" : "queued",
      attempts: attempt,
    });
  }
  expect(await worker.runNextJob(new AbortController().signal)).toBe("idle");
});
