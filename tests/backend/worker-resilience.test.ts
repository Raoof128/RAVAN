import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { MediaWorker, runLoops } from "../../apps/worker/src/main.js";
import { MediaPlanner } from "../../apps/api/src/media/planner.js";
import { PROBE_VERSION } from "../../apps/worker/src/probe.js";
import { sessionFixture } from "../fixtures/session-harness.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const source = { fileId: "file", generation: "a".repeat(64), sizeBytes: "10" };
async function database() {
  const dir = await mkdtemp(join(tmpdir(), "mov-resilience-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}
async function api(status: number) {
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.end(JSON.stringify({ error: "x" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no port");
  return `http://127.0.0.1:${address.port}`;
}
const job = (db: Awaited<ReturnType<typeof database>>) =>
  db.prepare("SELECT state,attempts FROM jobs").get();

it.each([
  ["is not listening (a restart)", undefined],
  ["is rate limiting", 429],
  ["cannot reach Drive", 503],
  ["has an internal error", 500],
])("does not charge a job when the API %s", async (_name, status) => {
  const db = await database();
  new JobQueue(db).enqueue("probe", "probe", source);
  // Port 9 refuses connections: the API process is not up yet.
  const origin = status ? await api(status) : "http://127.0.0.1:9";
  const worker = new MediaWorker(db, origin, "b".repeat(64));
  // Before, three back-to-back refusals failed the job for good within milliseconds.
  for (let i = 0; i < 6; i++) {
    expect(await worker.runNextJob(new AbortController().signal, "probe")).toBe(
      "retry",
    );
    expect(job(db)).toEqual({ state: "queued", attempts: 0 });
  }
});

it("still fails a job when the API says the film itself is gone", async () => {
  const db = await database();
  new JobQueue(db).enqueue("probe", "probe", source);
  const worker = new MediaWorker(db, await api(410), "b".repeat(64));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await worker.runNextJob(new AbortController().signal, "probe");
    expect(job(db)).toEqual({
      state: attempt === 3 ? "failed" : "queued",
      attempts: attempt,
    });
  }
});

it("waits longer after each put-back job and returns to full speed after a success", async () => {
  const outcomes = [
    "retry",
    "retry",
    "retry",
    "completed",
    "retry",
    "idle",
  ] as const;
  let call = 0;
  const controller = new AbortController();
  const waits: number[] = [];
  await runLoops(
    {
      queueLibrary: async () => {},
      runNextJob: async (_signal, lane) => {
        if (lane !== "prepare") return "idle";
        const outcome = outcomes[call++];
        if (!outcome) {
          controller.abort();
          return "idle";
        }
        return outcome;
      },
    },
    controller,
    async (ms) => {
      waits.push(ms);
    },
  );
  // 30000 is the planning ticker and 2000 an idle lane; the rest is the back-off.
  expect(waits.filter((ms) => ms !== 30000 && ms !== 2000)).toEqual([
    5000, 10000, 20000, 5000,
  ]);
});

it("keeps converting when planning throws, and stops cleanly only if failure persists", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => errors.mockRestore());
  const exitCode = process.exitCode;
  cleanup.push(async () => {
    process.exitCode = exitCode;
  });
  let converted = 0;
  const controller = new AbortController();
  await runLoops(
    {
      queueLibrary: async () => {
        throw new Error("database is locked");
      },
      runNextJob: async (_signal, lane) => {
        // A real job awaits I/O; yield the same way.
        await new Promise((resolve) => setImmediate(resolve));
        if (lane === "prepare") converted++;
        return "completed";
      },
    },
    controller,
    // Yield so every loop gets turns.
    () => new Promise((resolve) => setImmediate(resolve)),
  );
  // Planning failed twenty times running, so the worker asked to be restarted,
  // but conversions carried on throughout instead of being cut off at the first error.
  expect(controller.signal.aborted).toBe(true);
  expect(process.exitCode).toBe(1);
  expect(converted).toBeGreaterThan(0);
  expect(errors).toHaveBeenCalledTimes(20);
  // Only the cause is printed, never a path or a value.
  expect(errors.mock.calls[0]).toEqual([
    "Media worker step failed.",
    "database is locked",
  ]);
});

it("plans a film inspected before default-track data the conservative way, and inspects it again", async () => {
  const h = await sessionFixture();
  h.db
    .prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-f','m','f','Source','generation')",
    )
    .run();
  const record = (version: number) =>
    JSON.stringify({
      version,
      generation: "generation",
      probe: {
        durationMs: 7200000,
        container: "matroska,webm",
        video: {
          codec: "h264",
          pixelFormat: "yuv420p",
          width: 1920,
          height: 1080,
          hdr: false,
        },
        // Two tracks: an old probe cannot say which one the file marks as default.
        audio: [
          { codec: "aac", channels: 2 },
          { codec: "aac", channels: 2 },
        ],
        subtitles: [],
      },
    });
  h.db
    .prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','source-f','probe','metadata',?)",
    )
    .run(record(2));
  const film = { fileId: "f", generation: "generation", sizeBytes: "10" };
  const web = { id: "web", platform: "web" as const, verified: false };
  const capabilities = {
    video: ["h264" as const],
    audio: ["aac" as const],
    containers: ["mp4" as const, "matroska" as const],
  };
  // No worker storage to re-inspect with: the old record is used, without the
  // wider direct-play rules that need the missing data.
  expect(
    (
      await new MediaPlanner(h.db, false).planPlayback(film, web, {
        capabilities,
      })
    ).mode,
  ).not.toBe("direct");
  // With a worker: inspected again first.
  const planned = await new MediaPlanner(h.db, true, "/prepared").planPlayback(
    film,
    web,
    { capabilities },
  );
  expect(planned).toMatchObject({ mode: "prepare" });
  expect(h.db.prepare("SELECT kind,unique_key FROM jobs").all()).toEqual([
    { kind: "probe", unique_key: `probe-v${PROBE_VERSION}:f:generation` },
  ]);
  // Once re-inspected, the same request plays directly.
  h.db
    .prepare("UPDATE tracks SET metadata=? WHERE id='probe-f'")
    .run(record(PROBE_VERSION));
  expect(
    (
      await new MediaPlanner(h.db, true, "/prepared").planPlayback(film, web, {
        capabilities,
      })
    ).mode,
  ).toBe("direct");
});
