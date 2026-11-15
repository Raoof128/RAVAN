import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFixture } from "../fixtures/session-harness.js";
import { MediaPlanner, playableNow } from "../../apps/api/src/media/planner.js";
import { PlaybackService } from "../../apps/api/src/sessions/playback.js";
import { assetId } from "../../apps/worker/src/prepared-store.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
import { runProcess } from "../../apps/worker/src/process.js";
import {
  probeMedia,
  PROBE_VERSION,
  type Probe,
} from "../../apps/worker/src/probe.js";
import { validateEdition } from "../../apps/worker/src/hls.js";
import { openDatabase } from "../../packages/db/src/open.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const hour = 3600000;

it("starts a film that is still being prepared only when the viewer cannot catch up", () => {
  const film = { durationMs: 2 * hour, startedAt: 0, startMs: 0 };
  // Repackaging: 10 minutes of film in 10 seconds. A short lead is enough.
  expect(
    playableNow({ ...film, progress: (600000 / (2 * hour)) * 100, now: 10000 }),
  ).toBe(true);
  // Nothing, or less than the lead, prepared yet.
  expect(playableNow({ ...film, progress: 0, now: 10000 })).toBe(false);
  expect(
    playableNow({ ...film, progress: (10000 / (2 * hour)) * 100, now: 1000 }),
  ).toBe(false);
  // Encoding at half speed: after one hour, half an hour of film exists. The
  // viewer would reach the end of it long before the encoder finished.
  expect(playableNow({ ...film, progress: 25, now: hour })).toBe(false);
  // At half speed the safe point is half the film: the second half takes two
  // hours to prepare and two hours to reach.
  expect(playableNow({ ...film, progress: 49, now: 1.96 * hour })).toBe(false);
  expect(playableNow({ ...film, progress: 51, now: 2.04 * hour })).toBe(true);
  // Resuming near the end needs less of a head start, but that part must exist.
  expect(
    playableNow({
      ...film,
      progress: 51,
      now: 2.04 * hour,
      startMs: 1.5 * hour,
    }),
  ).toBe(false);
  expect(
    playableNow({
      ...film,
      progress: 90,
      now: 3.6 * hour,
      startMs: 1.5 * hour,
    }),
  ).toBe(true);
});

const probe: Probe = {
  durationMs: 2 * hour,
  container: "matroska,webm",
  video: {
    codec: "mpeg4",
    pixelFormat: "yuv420p",
    width: 640,
    height: 360,
    hdr: false,
  },
  audio: [{ codec: "ac3", channels: 6 }],
  subtitles: [{ codec: "subrip", index: 2, language: "eng" }],
};
async function fixture(record: Probe = probe) {
  const h = await sessionFixture();
  h.db
    .prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-f','m','f','Source','generation')",
    )
    .run();
  h.db
    .prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','source-f','probe','metadata',?)",
    )
    .run(
      JSON.stringify({
        version: PROBE_VERSION,
        generation: "generation",
        probe: record,
      }),
    );
  return h;
}
const source = { fileId: "f", generation: "generation", sizeBytes: "10" };
const web = { id: "web", platform: "web" as const, verified: false };
const tv = { id: "lg-c1", platform: "webos" as const, verified: false };
const single = assetId("f", "generation", "auto", 0);
const streamed = assetId("f", "generation", "auto", 0, false, "hls");

it("prepares a streamed edition for the web player and a single file for other clients", async () => {
  const h = await fixture();
  let now = 1_000_000;
  const planner = new MediaPlanner(h.db, true, "/prepared", () => now, {
    format: "hls",
  });
  const forWeb = await planner.planPlayback(source, web);
  const forTv = await planner.planPlayback(source, tv);
  expect(forWeb.mode).toBe("prepare");
  expect(forWeb.assetId).not.toBe(forTv.assetId);
  const payloads = (
    h.db.prepare("SELECT payload FROM jobs ORDER BY rowid").all() as Array<{
      payload: string;
    }>
  ).map((row) => JSON.parse(row.payload));
  expect(payloads.map((p) => [p.format, p.id])).toEqual([
    ["hls", streamed],
    ["mp4", single],
  ]);
  expect(
    h.db.prepare("SELECT id,format FROM prepared_assets ORDER BY rowid").all(),
  ).toEqual([
    { id: streamed, format: "hls" },
    { id: single, format: "mp4" },
  ]);
  // A server configured for single files behaves exactly as before.
  const plain = new MediaPlanner(h.db, true, "/prepared", () => now);
  expect((await plain.planPlayback(source, web)).assetId).toBe(forTv.assetId);
  now += 1;
});

it("reuses a single-file edition that was already finished instead of preparing again", async () => {
  const h = await fixture();
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,label) VALUES(?,'f','generation','auto',0,'ready',0,'360p · H.264')",
    )
    .run(single);
  const planner = new MediaPlanner(h.db, true, "/prepared", Date.now, {
    format: "hls",
  });
  expect(await planner.planPlayback(source, web)).toEqual({
    mode: "prepared",
    assetId: single,
    label: "360p · H.264",
  });
  expect(h.db.prepare("SELECT * FROM jobs").all()).toEqual([]);
});

async function streaming(progress: number, elapsedMs: number) {
  const h = await fixture();
  const now = 10_000_000;
  const planner = new MediaPlanner(h.db, true, "/prepared", () => now, {
    format: "hls",
  });
  const first = await planner.planPlayback(source, web);
  const queue = new JobQueue(h.db, () => now - elapsedMs);
  const job = queue.claim("prepare")!;
  h.db
    .prepare("UPDATE jobs SET progress=?,lease_until=? WHERE id=?")
    .run(progress, now + 60000, job.id);
  h.db
    .prepare(
      "UPDATE prepared_assets SET state='streaming',label='360p · H.264' WHERE id=?",
    )
    .run(streamed);
  return { h, planner, jobId: first.assetId };
}

it("offers a growing edition once it is safe to start, and says so while it is not", async () => {
  // Ten minutes of film prepared in one minute: far faster than playback.
  const fast = await streaming(8.4, 60000);
  expect(await fast.planner.planPlayback(source, web)).toEqual({
    mode: "prepared",
    assetId: streamed,
    label: "360p · H.264",
    live: true,
  });
  // Resuming an hour in must wait until that part exists.
  expect(
    (await fast.planner.planPlayback(source, web, { startMs: hour })).mode,
  ).toBe("prepare");
  // Background planning never treats a growing edition as finished.
  expect((await fast.planner.planPlayback(source, web, {}, true)).mode).toBe(
    "prepare",
  );
  // A slow conversion: a quarter prepared after an hour.
  const slow = await streaming(25, hour);
  const waiting = await slow.planner.planPlayback(source, web);
  expect(waiting).toMatchObject({ mode: "prepare", progress: 25 });
  expect(waiting.reason).toContain("Playback starts once enough is ready");
});

it("serves a growing edition's own files to its session, and captions only when complete", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-live-")));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const h = await sessionFixture({ preparedDir: dir, preparedFormat: "hls" });
  const id = "d".repeat(64);
  await mkdir(join(dir, id));
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:6.000000,",
    "seg-00000.m4s",
  ];
  await writeFile(join(dir, id, "index.m3u8"), playlist.join("\n") + "\n");
  await writeFile(join(dir, id, "init.mp4"), "INIT");
  await writeFile(join(dir, id, "seg-00000.m4s"), "0123456789");
  await writeFile(join(dir, id, "subtitle-0.vtt"), "WEBVTT\n\npartial");
  await writeFile(join(dir, id, "video.mp4"), "not part of this layout");
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,format,label) VALUES(?,'f','generation','auto',0,'streaming',0,'hls','360p')",
    )
    .run(id);
  const service = new PlaybackService(
    h.db,
    async () => ({ fileId: "f", generation: "generation", sizeBytes: "10" }),
    async () => ({ mode: "prepared", assetId: id, live: true }),
  );
  const result = await service.create("m", "web", 0, { webHash: "owner" });
  if (result.kind !== "ready") throw Error("not ready");
  expect(result.session.mediaUrl).toMatch(
    /^\/media\/s\/[\w-]{43}\/index\.m3u8$/,
  );
  expect(result.session.subtitles).toEqual([]);
  const base = result.session.mediaUrl.replace("index.m3u8", "");
  const served = await h.app.inject(result.session.mediaUrl);
  expect(served.statusCode).toBe(200);
  expect(served.headers["content-type"]).toContain(
    "application/vnd.apple.mpegurl",
  );
  expect(served.headers["cache-control"]).toBe("no-store");
  expect(served.body).toBe(playlist.join("\n") + "\n");
  expect((await h.app.inject(base + "init.mp4")).body).toBe("INIT");
  const part = await h.app.inject({
    url: base + "seg-00000.m4s",
    headers: { range: "bytes=2-5" },
  });
  expect([part.statusCode, part.body]).toEqual([206, "2345"]);
  // Not this layout's file, not a listed segment name, and captions still being written.
  for (const path of [
    "video.mp4",
    "raw",
    "subtitle-0.vtt",
    "seg-0.m4s",
    "seg-00000.m4s.tmp",
    "../" + id + "/init.mp4",
  ])
    expect((await h.app.inject(base + path)).statusCode, path).toBe(403);
  // A playlist that is not exactly what this server writes is never passed on.
  await writeFile(
    join(dir, id, "index.m3u8"),
    [...playlist, "#EXTINF:6.0,", "https://evil.example/seg-00001.m4s"].join(
      "\n",
    ),
  );
  expect((await h.app.inject(result.session.mediaUrl)).statusCode).toBe(403);
  // Finished: the heartbeat now carries the captions, and they are served.
  await writeFile(
    join(dir, id, "index.m3u8"),
    [...playlist, "#EXT-X-ENDLIST"].join("\n"),
  );
  h.db
    .prepare("UPDATE prepared_assets SET state='ready',subtitles=? WHERE id=?")
    .run(
      JSON.stringify([
        { file: "subtitle-0.vtt", language: "en", label: "English" },
      ]),
      id,
    );
  const beat = await service.heartbeat(result.session.id, { webHash: "owner" });
  expect(beat.subtitles).toHaveLength(1);
  expect((await h.app.inject(base + "subtitle-0.vtt")).statusCode).toBe(200);
  // The conversion failed and the edition was withdrawn: nothing more is served.
  h.db.prepare("UPDATE prepared_assets SET state='queued' WHERE id=?").run(id);
  expect((await h.app.inject(result.session.mediaUrl)).statusCode).toBe(403);
  // The session's address must not flip to the other layout's file meanwhile,
  // or the player would reload onto something that can never play.
  expect(
    (await service.heartbeat(result.session.id, { webHash: "owner" })).mediaUrl,
  ).toBe(result.session.mediaUrl);
});

it("does not interrupt a conversion that someone is watching as it grows", async () => {
  const h = await fixture();
  const queue = new JobQueue(h.db);
  queue.enqueue("browser-prepare", "watched", { id: streamed });
  const running = queue.claim("prepare")!;
  expect(
    h.db.prepare("SELECT started_at FROM jobs WHERE id=?").get(running.id),
  ).not.toEqual({ started_at: null });
  queue.enqueue("browser-prepare", "other", {}, Date.now() + 60000);
  expect(queue.shouldYield(running)).toBe(true);
  h.db
    .prepare(
      "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,epoch,lease_until,access_until,expires_at,asset_id) VALUES('s','t','m','f','generation',1,?,?,?,?)",
    )
    .run(Date.now() + 60000, Date.now() + 60000, Date.now() + 60000, streamed);
  expect(queue.shouldYield(running)).toBe(false);
});

it("repackages a large original when the prepared volume has been enlarged", async () => {
  const h = await fixture({
    ...probe,
    video: { ...probe.video!, codec: "h264" },
    subtitles: [{ codec: "subrip", index: 2 }],
  });
  const large = { ...source, sizeBytes: String(30 * 1024 ** 3) };
  const forced = (planner: MediaPlanner) =>
    planner
      .planPlayback(large, web)
      .then(
        () =>
          JSON.parse(
            (
              h.db
                .prepare("SELECT payload FROM jobs ORDER BY rowid DESC")
                .get() as { payload: string }
            ).payload,
          ).forceEncode as boolean,
      );
  // 20 GiB volume: a 30 GiB copy cannot fit, so it is re-encoded smaller.
  expect(await forced(new MediaPlanner(h.db, true, "/prepared"))).toBe(true);
  expect(
    await forced(
      new MediaPlanner(h.db, true, "/prepared", Date.now, {
        capacityBytes: 100 * 1024 ** 3,
      }),
    ),
  ).toBe(false);
});

it("streams a real conversion while it runs, then finishes it, and withdraws it if it fails", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mov-live-")));
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
      "40",
      "-c:v",
      "mpeg4",
      "-b:v",
      "40k",
      input,
    ],
    new AbortController().signal,
    30000,
  );
  const real = await probeMedia(input, new AbortController().signal);
  const bytes = await readFile(input);
  const generation = "a".repeat(64);
  const film = { fileId: "file", generation, sizeBytes: String(bytes.length) };
  let cut = false;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/_worker/verify/")) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify(film));
    }
    if (request.url?.startsWith("/_worker/grant")) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ token: "g".repeat(43) }));
    }
    response.writeHead(200, { "content-length": bytes.length });
    let offset = 0;
    const timer = setInterval(() => {
      if (cut && offset > bytes.length / 2) {
        clearInterval(timer);
        return response.destroy();
      }
      if (offset >= bytes.length) {
        clearInterval(timer);
        return response.end();
      }
      response.write(bytes.subarray(offset, (offset += 4096)));
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
    `INSERT INTO movies(id,title) VALUES('m','Film'); INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('file','m','${generation}','1'); INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-file','m','file','Original','${generation}')`,
  );
  db.prepare(
    "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-file','source-file','probe','metadata',?)",
  ).run(JSON.stringify({ generation, probe: real, version: PROBE_VERSION }));
  const prepared = join(dir, "prepared");
  const queue = new JobQueue(db);
  const worker = new MediaWorker(
    db,
    `http://127.0.0.1:${address.port}`,
    "c".repeat(64),
    { directory: prepared, dataDir: dir, production: false, format: "hls" },
  );
  const run = async (id: string) => {
    db.prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,last_used,format) VALUES(?,'file',?,'auto',0,0,'hls')",
    ).run(id, generation);
    queue.enqueue("browser-prepare", id, {
      source: film,
      quality: "auto",
      audio: 0,
      forceEncode: false,
      format: "hls",
      id,
    });
    const states = new Set<string>();
    let playableWhileRunning = false;
    const watch = setInterval(() => {
      const row = db
        .prepare("SELECT state FROM prepared_assets WHERE id=?")
        .get(id) as { state: string };
      states.add(row.state);
      if (
        row.state === "streaming" &&
        db.prepare("SELECT 1 FROM jobs WHERE state='running'").get()
      )
        playableWhileRunning = true;
    }, 20);
    const outcome = await worker.runNextJob(
      new AbortController().signal,
      "prepare",
    );
    clearInterval(watch);
    return { outcome, states, playableWhileRunning };
  };
  const first = "1".repeat(64);
  const ok = await run(first);
  expect(ok.outcome).toBe("completed");
  // It was offered for playback before the conversion finished.
  expect(ok.playableWhileRunning).toBe(true);
  expect(
    db
      .prepare("SELECT state,format FROM prepared_assets WHERE id=?")
      .get(first),
  ).toEqual({ state: "ready", format: "hls" });
  expect((await validateEdition(join(prepared, first))).ended).toBe(true);
  // The same conversion with the source cut off half way.
  cut = true;
  const second = "2".repeat(64);
  const failed = await run(second);
  expect(failed.outcome).toBe("retry");
  expect(
    db.prepare("SELECT state FROM prepared_assets WHERE id=?").get(second),
  ).toEqual({ state: "queued" });
  await expect(stat(join(prepared, second))).rejects.toThrow();
  // The finished edition is untouched.
  expect((await validateEdition(join(prepared, first))).ended).toBe(true);
}, 60000);

it("does not offer an edition whose worker has died, or trust progress from an earlier attempt", async () => {
  const { h, planner } = await streaming(8.4, 60000);
  expect((await planner.planPlayback(source, web)).mode).toBe("prepared");
  // The worker was killed: its lease ran out and nothing is writing segments.
  h.db.prepare("UPDATE jobs SET lease_until=?").run(10_000_000 - 1);
  expect((await planner.planPlayback(source, web)).mode).toBe("prepare");
  // The next attempt starts from nothing, whatever the last one had reached.
  const queue = new JobQueue(h.db, () => 10_000_000);
  expect(queue.claim("prepare")).toBeDefined();
  expect(h.db.prepare("SELECT progress,started_at FROM jobs").get()).toEqual({
    progress: 0,
    started_at: 10_000_000,
  });
  expect((await planner.planPlayback(source, web)).mode).toBe("prepare");
});

it("does not rebuild in the background an edition that was reclaimed in the other layout", async () => {
  const h = await fixture();
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used) VALUES(?,'f','generation','auto',0,'evicted',0)",
    )
    .run(single);
  const planner = new MediaPlanner(h.db, true, "/prepared", Date.now, {
    format: "hls",
  });
  expect(await planner.planPlayback(source, web, {}, true)).toMatchObject({
    mode: "unsupported",
  });
  expect(h.db.prepare("SELECT * FROM jobs").all()).toEqual([]);
  // The viewer asking for it is another matter.
  expect((await planner.planPlayback(source, web)).mode).toBe("prepare");
  expect(h.db.prepare("SELECT COUNT(*) n FROM jobs").get()).toEqual({ n: 1 });
});
