import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { JobQueue, RETRY_COOLDOWN_MS } from "../../apps/worker/src/leases.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mov-priority-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let now = 1_000_000_000;
  return {
    db,
    queue: new JobQueue(db, () => now),
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("prepares the film a viewer is waiting on before earlier background work", async () => {
  const { queue, clock } = await fixture();
  for (let i = 0; i < 5; i++)
    queue.enqueue("browser-prepare", `background-${i}`, {});
  // The viewer opens the fourth film; its job already exists and moves to the front.
  const wanted = queue.enqueue("browser-prepare", "background-3", {}, clock());
  expect(queue.claim("prepare")?.id).toBe(wanted);
});

it("claims by most recent request, then by age for background work", async () => {
  const { queue, clock, advance } = await fixture();
  const background = queue.enqueue("browser-prepare", "background", {});
  const first = queue.enqueue("browser-prepare", "first", {}, clock());
  advance(60000);
  const latest = queue.enqueue("browser-prepare", "latest", {}, clock());
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const job = queue.claim("prepare")!;
    order.push(job.id);
    queue.complete(job);
  }
  expect(order).toEqual([latest, first, background]);
});

it("inspects a newly opened film while a conversion is running", async () => {
  const { queue } = await fixture();
  const conversion = queue.enqueue("browser-prepare", "conversion", {});
  const probe = queue.enqueue("probe", "probe", {});
  queue.enqueue("probe", "second-probe", {});
  expect(queue.claim("prepare")?.id).toBe(conversion);
  expect(queue.claim("probe")?.id).toBe(probe);
  // Still one job per lane.
  expect(queue.claim("probe")).toBeUndefined();
  expect(queue.claim("prepare")).toBeUndefined();
});

it("does not hold conversions back while something is being watched", async () => {
  const { queue, db, clock } = await fixture();
  db.exec(
    "INSERT INTO movies(id,title) VALUES('m','Film'); INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('f','m','g','10')",
  );
  db.prepare(
    "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,epoch,lease_until,access_until,expires_at) VALUES('s','t','m','f','g',1,?,?,?)",
  ).run(clock() + 60000, clock() + 60000, clock() + 60000);
  const job = queue.enqueue("browser-prepare", "other-film", {});
  expect(queue.claim("prepare")?.id).toBe(job);
});

it("interrupts background work for a viewer, but not work that is nearly done", async () => {
  const { queue, db, clock, advance } = await fixture();
  queue.enqueue("browser-prepare", "background", {});
  const running = queue.claim("prepare")!;
  expect(queue.shouldYield(running)).toBe(false);
  // A probe request never interrupts a conversion; it has its own lane.
  queue.enqueue("probe", "probe", {}, clock());
  expect(queue.shouldYield(running)).toBe(false);
  queue.enqueue("browser-prepare", "wanted", {}, clock());
  expect(queue.shouldYield(running)).toBe(true);
  db.prepare("UPDATE jobs SET progress=95 WHERE id=?").run(running.id);
  expect(queue.shouldYield(running)).toBe(false);
  db.prepare("UPDATE jobs SET progress=40 WHERE id=?").run(running.id);
  // The viewer keeps waiting on the running film: its own request stays newest.
  advance(5000);
  queue.enqueue("browser-prepare", "background", {}, clock());
  expect(queue.shouldYield(running)).toBe(false);
});

it("retries a failed job on request after a cool-down, with fresh attempts", async () => {
  const { queue, db, advance } = await fixture();
  const id = queue.enqueue("browser-prepare", "film", {});
  for (let attempt = 0; attempt < 3; attempt++)
    queue.fail(queue.claim("prepare")!, "media_source");
  expect(db.prepare("SELECT state FROM jobs").get()).toEqual({
    state: "failed",
  });
  expect(queue.retry(id)).toBe(false);
  advance(RETRY_COOLDOWN_MS);
  expect(queue.retry(id)).toBe(true);
  expect(
    db.prepare("SELECT state,attempts,error_code,progress FROM jobs").get(),
  ).toEqual({ state: "queued", attempts: 0, error_code: null, progress: 0 });
  expect(queue.retry(id)).toBe(false);
  expect(queue.claim("prepare")?.id).toBe(id);
});

it("records the failure time when a crashed job runs out of attempts", async () => {
  const { queue, db, advance, clock } = await fixture();
  const id = queue.enqueue("browser-prepare", "film", {});
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(queue.claim("prepare")?.id).toBe(id);
    advance(70000);
  }
  expect(queue.claim("prepare")).toBeUndefined();
  expect(db.prepare("SELECT state,failed_at FROM jobs").get()).toEqual({
    state: "failed",
    failed_at: clock(),
  });
});
