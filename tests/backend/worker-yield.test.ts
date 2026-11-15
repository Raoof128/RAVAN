import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
import { runProcess } from "../../apps/worker/src/process.js";
import { PROBE_VERSION, probeMedia } from "../../apps/worker/src/probe.js";
import { MediaPlanner } from "../../apps/api/src/media/planner.js";
import { RETRY_COOLDOWN_MS } from "../../apps/worker/src/leases.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const generation = "a".repeat(64);
const asset = "b".repeat(64);

it("a running background conversion makes way for the film a viewer asks for", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mov-yield-")));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "source.mkv");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=12",
      "-t",
      "4",
      "-c:v",
      "mpeg4",
      input,
    ],
    new AbortController().signal,
    15000,
  );
  const probe = await probeMedia(input, new AbortController().signal);
  const bytes = await readFile(input);
  const source = {
    fileId: "file",
    generation,
    sizeBytes: String(bytes.length),
  };
  const credentials: string[] = [];
  // Stands in for the API: verification answers at once, source bytes trickle.
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/_worker/verify/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(source));
      return;
    }
    if (request.url?.startsWith("/_worker/grant")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ token: "g".repeat(43) }));
      return;
    }
    // FFmpeg must present the per-file grant, never the worker key.
    credentials.push(request.headers.authorization ?? "");
    response.writeHead(200, {
      "content-type": "video/x-matroska",
      "content-length": bytes.length,
    });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= bytes.length) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(bytes.subarray(offset, (offset += 1024)));
    }, 60);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no port");

  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => db.close());
  db.exec(
    "INSERT INTO movies(id,title) VALUES('m','Film'); INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('file','m','" +
      generation +
      "','1'); INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-file','m','file','Original','" +
      generation +
      "')",
  );
  db.prepare(
    "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-file','source-file','probe','metadata',?)",
  ).run(JSON.stringify({ generation, probe, version: PROBE_VERSION }));
  const prepared = join(dir, "prepared");
  const queue = new JobQueue(db);
  const background = queue.enqueue("browser-prepare", "background", {
    source,
    quality: "auto",
    audio: 0,
    forceEncode: false,
    id: asset,
  });
  const worker = new MediaWorker(
    db,
    `http://127.0.0.1:${address.port}`,
    "c".repeat(64),
    { directory: prepared, dataDir: dir, production: false },
    40,
  );
  const running = worker.runNextJob(new AbortController().signal, "prepare");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(
    db.prepare("SELECT state FROM jobs WHERE id=?").get(background),
  ).toEqual({ state: "running" });
  const wanted = queue.enqueue(
    "browser-prepare",
    "wanted",
    {},
    Date.now() + 60000,
  );
  expect(await running).toBe("retry");
  // The conversion really was reading its source when it was interrupted.
  expect(credentials.length).toBeGreaterThan(0);
  expect(new Set(credentials)).toEqual(new Set([`Bearer ${"g".repeat(43)}`]));
  // Not a failure: the interrupted job keeps all three attempts and no partial output.
  expect(
    db.prepare("SELECT state,attempts FROM jobs WHERE id=?").get(background),
  ).toEqual({ state: "queued", attempts: 0 });
  expect(await readdir(prepared)).toEqual([]);
  expect(queue.claim("prepare")?.id).toBe(wanted);
});

it("an owner's new request retries a failed preparation, background work does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-retry-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => db.close());
  db.exec(
    "INSERT INTO movies(id,title) VALUES('m','Film'); INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('file','m','g','10'); INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-file','m','file','Original','g')",
  );
  db.prepare(
    "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-file','source-file','probe','metadata',?)",
  ).run(
    JSON.stringify({
      generation: "g",
      version: PROBE_VERSION,
      probe: {
        durationMs: 60000,
        container: "matroska,webm",
        video: {
          codec: "mpeg4",
          pixelFormat: "yuv420p",
          width: 640,
          height: 360,
          hdr: false,
        },
        audio: [],
        subtitles: [],
      },
    }),
  );
  let now = 1_000_000_000;
  const planner = new MediaPlanner(db, true, "/prepared", () => now);
  const source = { fileId: "file", generation: "g", sizeBytes: "10" };
  const profile = { id: "web", platform: "web" as const, verified: false };
  const first = await planner.planPlayback(source, profile);
  expect(first.mode).toBe("prepare");
  const queue = new JobQueue(db, () => now);
  for (let attempt = 0; attempt < 3; attempt++)
    queue.fail(queue.claim("prepare")!, "media_source");
  // Straight after the failure the owner sees why, not an endless spinner.
  const failed = await planner.planPlayback(source, profile);
  expect(failed).toMatchObject({ mode: "unsupported" });
  expect(failed.reason).toContain("Google Drive");
  now += RETRY_COOLDOWN_MS;
  expect((await planner.planPlayback(source, profile, {}, true)).mode).toBe(
    "unsupported",
  );
  const retried = await planner.planPlayback(source, profile);
  expect(retried).toMatchObject({ mode: "prepare", assetId: first.assetId });
  expect(db.prepare("SELECT state,attempts FROM jobs").get()).toEqual({
    state: "queued",
    attempts: 0,
  });
});
