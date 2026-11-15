import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversionPlan } from "../../apps/worker/src/compatibility.js";
import {
  choosePlayback,
  MediaPlanner,
  storedCapabilities,
} from "../../apps/api/src/media/planner.js";
import { assetId } from "../../apps/worker/src/prepared-store.js";
import { prepareBrowser } from "../../apps/worker/src/browser-prepare.js";
import { probeMedia, type Probe } from "../../apps/worker/src/probe.js";
import { runProcess } from "../../apps/worker/src/process.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { sessionFixture } from "../fixtures/session-harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import type { ClientCapabilities } from "../../packages/contracts/src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
// A current desktop browser with hardware HEVC, and Safari-style Dolby audio.
const modern: ClientCapabilities = {
  video: ["h264", "hevc", "hevc10", "av1", "vp9", "vp8"],
  audio: ["aac", "mp3", "ac3", "eac3", "flac", "opus", "vorbis"],
  containers: ["mp4", "webm", "matroska"],
};
// A browser with no HEVC and no Matroska: what the server assumed for everyone.
const basic: ClientCapabilities = {
  video: ["h264", "vp9", "vp8"],
  audio: ["aac", "mp3", "opus", "vorbis"],
  containers: ["mp4", "webm"],
};
const film = (
  overrides: Partial<Probe> & { video?: Probe["video"] },
): Probe => ({
  durationMs: 7200000,
  container: "matroska,webm",
  video: {
    codec: "h264",
    pixelFormat: "yuv420p",
    width: 1920,
    height: 1080,
    hdr: false,
  },
  audio: [{ codec: "aac", channels: 2 }],
  subtitles: [],
  ...overrides,
});
const hdr4k = film({
  video: {
    codec: "hevc",
    pixelFormat: "yuv420p10le",
    width: 3840,
    height: 1600,
    hdr: true,
    transfer: "smpte2084",
  },
  audio: [{ codec: "eac3", channels: 6 }],
});

it("repackages a 4K HDR HEVC film for a browser that decodes it, instead of re-encoding", () => {
  // Nothing reported: the hours-long tone-mapped H.264 conversion, as before.
  expect(conversionPlan(hdr4k, "auto")).toMatchObject({
    copyVideo: false,
    toneMap: true,
    width: 1920,
    height: 800,
    variant: "",
  });
  expect(conversionPlan(hdr4k, "auto", false, basic.video)).toMatchObject({
    copyVideo: false,
    toneMap: true,
  });
  // 10-bit HEVC reported: the picture is copied untouched at full size.
  expect(conversionPlan(hdr4k, "auto", false, modern.video)).toMatchObject({
    copyVideo: true,
    toneMap: false,
    width: 3840,
    height: 1600,
    variant: "copy-hevc",
  });
  // 8-bit HEVC support alone does not cover a 10-bit source.
  expect(conversionPlan(hdr4k, "auto", false, ["h264", "hevc"]).copyVideo).toBe(
    false,
  );
  // An explicit size or a compatibility fallback still re-encodes.
  expect(conversionPlan(hdr4k, "1080p", false, modern.video)).toMatchObject({
    copyVideo: false,
    toneMap: true,
    height: 800,
  });
  expect(conversionPlan(hdr4k, "auto", true, modern.video).copyVideo).toBe(
    false,
  );
});

it("keeps one shared edition where the plan is the same for every client", () => {
  const h264 = film({});
  expect(conversionPlan(h264, "auto", false, modern.video)).toMatchObject({
    copyVideo: true,
    variant: "",
  });
  expect(conversionPlan(h264, "auto").variant).toBe("");
  // 4K H.264: copied for a reporting client, shrunk to 1080p for one that is not.
  const large = film({
    video: { ...h264.video!, width: 3840, height: 2160 },
  });
  expect(conversionPlan(large, "auto")).toMatchObject({
    copyVideo: false,
    height: 1080,
    variant: "",
  });
  expect(conversionPlan(large, "auto", false, modern.video)).toMatchObject({
    copyVideo: true,
    height: 2160,
    variant: "copy-h264",
  });
  // An edition only some clients can play never shares an identity with the universal one.
  expect(assetId("f", "g", "auto", 0, false, "copy-hevc")).not.toBe(
    assetId("f", "g", "auto", 0),
  );
  expect(assetId("f", "g", "auto", 0, false, "")).toBe(
    assetId("f", "g", "auto", 0),
  );
});

it("copies AV1 for a client that decodes it and never puts VP9 or 10-bit H.264 in MP4", () => {
  const codec = (name: string, pixelFormat = "yuv420p") =>
    film({ video: { ...film({}).video!, codec: name, pixelFormat } });
  expect(
    conversionPlan(codec("av1"), "auto", false, modern.video),
  ).toMatchObject({ copyVideo: true, variant: "copy-av1" });
  expect(
    conversionPlan(codec("av1"), "auto", false, basic.video).copyVideo,
  ).toBe(false);
  for (const source of [
    codec("vp9"),
    codec("h264", "yuv420p10le"),
    codec("mpeg2video"),
    codec("vc1"),
  ])
    expect(conversionPlan(source, "auto", false, modern.video).copyVideo).toBe(
      false,
    );
});

it("plays an original directly whenever this browser reports it can", () => {
  const mkv = film({ audio: [{ codec: "ac3", channels: 6 }] });
  // Matroska with H.264 and AC-3: direct for a browser that plays all three.
  expect(choosePlayback(mkv, "web", modern).mode).toBe("direct");
  expect(choosePlayback(mkv, "web", basic).mode).toBe("prepare");
  expect(choosePlayback(mkv, "web").mode).toBe("prepare");
  // HDR HEVC in MP4 with Dolby Digital Plus.
  const mp4 = { ...hdr4k, container: "mov,mp4,m4a,3gp,3g2,mj2" };
  expect(choosePlayback(mp4, "web", modern).mode).toBe("direct");
  expect(choosePlayback(mp4, "web", basic).mode).toBe("prepare");
  // The television profile is capped at 1080p whatever it reports.
  expect(choosePlayback(mp4, "lg-c1", modern).mode).toBe("prepare");
  // 5.1 AAC and a second, non-default track no longer force a conversion.
  const surround = film({
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    audio: [
      { codec: "aac", channels: 6 },
      { codec: "aac", channels: 2 },
    ],
  });
  expect(choosePlayback(surround, "web", basic).mode).toBe("direct");
  expect(choosePlayback(surround, "web").mode).toBe("prepare");
});

it("still prepares when the browser could not show or hear the original correctly", () => {
  // Audio the browser cannot decode would play silently.
  expect(
    choosePlayback(
      film({ audio: [{ codec: "dts", channels: 6 }] }),
      "web",
      modern,
    ).mode,
  ).toBe("prepare");
  expect(
    choosePlayback(film({ audio: [{ codec: "ac3", channels: 6 }] }), "web", {
      ...modern,
      audio: ["aac"],
    }).mode,
  ).toBe("prepare");
  // The default track is not the first: the player could not select it.
  expect(
    choosePlayback(
      film({
        audio: [
          { codec: "aac", channels: 2 },
          { codec: "aac", channels: 2, default: true },
        ],
      }),
      "web",
      modern,
    ).mode,
  ).toBe("prepare");
  // Text subtitles need extracting; image subtitles cannot be shown either way.
  expect(
    choosePlayback(
      film({ subtitles: [{ codec: "subrip", language: "fas" }] }),
      "web",
      modern,
    ).mode,
  ).toBe("prepare");
  expect(
    choosePlayback(
      film({ subtitles: [{ codec: "hdmv_pgs_subtitle" }] }),
      "web",
      modern,
    ).mode,
  ).toBe("direct");
  // 10-bit H.264 and unknown containers.
  expect(
    choosePlayback(
      film({ video: { ...film({}).video!, pixelFormat: "yuv420p10le" } }),
      "web",
      modern,
    ).mode,
  ).toBe("prepare");
  expect(choosePlayback(film({ container: "avi" }), "web", modern).mode).toBe(
    "prepare",
  );
});

it("tells WebM from Matroska by the file, since browsers treat them differently", () => {
  const open = film({
    video: { ...film({}).video!, codec: "vp9" },
    audio: [{ codec: "opus", channels: 2 }],
  });
  expect(
    choosePlayback(open, "web", basic, {
      name: "Film.webm",
      mimeType: "video/webm",
    }).mode,
  ).toBe("direct");
  // The same streams in a .mkv need Matroska support, which this browser lacks.
  expect(
    choosePlayback(open, "web", basic, {
      name: "Film.mkv",
      mimeType: "video/x-matroska",
    }).mode,
  ).toBe("prepare");
  expect(choosePlayback(open, "web", modern, { name: "Film.mkv" }).mode).toBe(
    "direct",
  );
  // H.264 is not a WebM codec even when the file is named that way.
  expect(
    choosePlayback(film({}), "web", basic, { name: "Film.webm" }).mode,
  ).toBe("prepare");
});

async function plannerFixture(probe: Probe, name = "Film.mkv") {
  const h = await sessionFixture();
  h.db
    .prepare("UPDATE source_files SET name=?,mime_type=? WHERE id='f'")
    .run(name, name.endsWith(".mkv") ? "video/x-matroska" : "video/mp4");
  h.db
    .prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-f','m','f','Source','generation')",
    )
    .run();
  h.db
    .prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','source-f','probe','metadata',?)",
    )
    .run(JSON.stringify({ version: 3, generation: "generation", probe }));
  return h;
}
const source = { fileId: "f", generation: "generation", sizeBytes: "10" };
const web = { id: "web", platform: "web" as const, verified: false };

it("plans a direct play with no job at all when the browser reports support", async () => {
  const h = await plannerFixture(
    film({ audio: [{ codec: "ac3", channels: 6 }] }),
  );
  const planner = new MediaPlanner(h.db, true, "/prepared");
  expect(
    await planner.planPlayback(source, web, { capabilities: modern }),
  ).toMatchObject({ mode: "direct" });
  expect(h.db.prepare("SELECT * FROM jobs").all()).toEqual([]);
  // The compatibility fallback and a non-default audio track still prepare.
  expect(
    (
      await planner.planPlayback(source, web, {
        capabilities: modern,
        forceCompatible: true,
      })
    ).mode,
  ).toBe("prepare");
  // Without a report the same file is converted, as it always was.
  expect((await planner.planPlayback(source, web)).mode).toBe("prepare");
});

it("queues the quick repackaging edition, separately from the universal one", async () => {
  const h = await plannerFixture({
    ...hdr4k,
    subtitles: [{ codec: "subrip", language: "eng", index: 2 }],
  });
  const planner = new MediaPlanner(h.db, true, "/prepared");
  const copy = await planner.planPlayback(source, web, {
    capabilities: modern,
  });
  const universal = await planner.planPlayback(source, web);
  expect(copy.mode).toBe("prepare");
  expect(universal.mode).toBe("prepare");
  expect(copy.assetId).not.toBe(universal.assetId);
  const payloads = (
    h.db.prepare("SELECT payload FROM jobs ORDER BY rowid").all() as Array<{
      payload: string;
    }>
  ).map((row) => JSON.parse(row.payload));
  expect(payloads[0].video).toEqual(modern.video);
  expect(payloads[0].id).toBe(
    assetId("f", "generation", "auto", 0, false, "copy-hevc"),
  );
  expect(payloads[1].video).toBeUndefined();
  expect(payloads[1].id).toBe(assetId("f", "generation", "auto", 0));
});

it("remembers the browser's report and drops background conversions it made pointless", async () => {
  const h = await plannerFixture(
    film({ audio: [{ codec: "ac3", channels: 6 }] }),
  );
  const dir = await mkdtemp(join(tmpdir(), "mov-caps-"));
  dirs.push(dir);
  const worker = new MediaWorker(h.db, "http://127.0.0.1:9", "c".repeat(64), {
    directory: dir,
    dataDir: dir,
    production: false,
  });
  // Before any browser has played: the universal conversion is queued in the background.
  expect(storedCapabilities(h.db)).toBeUndefined();
  await worker.queueLibrary();
  expect(h.db.prepare("SELECT kind,priority FROM jobs").all()).toEqual([
    { kind: "browser-prepare", priority: 0 },
  ]);
  // The owner's browser reports that it can take the original directly.
  const planner = new MediaPlanner(h.db, true, dir);
  planner.rememberCapabilities(modern);
  expect(
    (await planner.planPlayback(source, web, { capabilities: modern })).mode,
  ).toBe("direct");
  expect(storedCapabilities(h.db)).toEqual(modern);
  await worker.queueLibrary();
  expect(h.db.prepare("SELECT * FROM jobs").all()).toEqual([]);
  expect(h.db.prepare("SELECT * FROM prepared_assets").all()).toEqual([]);
  // Planning on its own never changes the stored report.
  await planner.planPlayback(source, web, { capabilities: basic });
  expect(storedCapabilities(h.db)).toEqual(modern);
});

it("lets only the owner's browser session set what background work plans for", async () => {
  const h = await plannerFixture(film({}), "Film.mp4");
  const s = issueSession(h.db, "owner");
  h.db
    .prepare("INSERT INTO devices(id,name,token_hash) VALUES('tv','TV',?)")
    .run(
      (await import("../../apps/api/src/auth/sessions.js")).hash(
        "d".repeat(43),
      ),
    );
  const play = (headers: Record<string, string>, capabilities: unknown) =>
    h.app.inject({
      method: "POST",
      url: "/api/playback",
      headers,
      // A paired device may claim any profile name it likes.
      payload: { movieId: "m", profileId: "web", capabilities },
    });
  await play({ authorization: `Bearer ${"d".repeat(43)}` }, basic);
  expect(storedCapabilities(h.db)).toBeUndefined();
  await play(
    {
      cookie: `mov_session=${s.token}`,
      origin: "http://localhost:4310",
      "x-csrf-token": s.csrf,
    },
    modern,
  );
  expect(storedCapabilities(h.db)).toEqual(modern);
  await play({ authorization: `Bearer ${"d".repeat(43)}` }, basic);
  expect(storedCapabilities(h.db)).toEqual(modern);
});

it("never drops a conversion that a viewer asked for or that is running", async () => {
  const h = await plannerFixture(
    film({ audio: [{ codec: "ac3", channels: 6 }] }),
  );
  const dir = await mkdtemp(join(tmpdir(), "mov-caps-"));
  dirs.push(dir);
  new MediaPlanner(h.db, true, dir).rememberCapabilities(modern);
  const queue = new JobQueue(h.db);
  const asked = queue.enqueue(
    "browser-prepare",
    "asked",
    { id: "a".repeat(64) },
    Date.now(),
  );
  const started = queue.enqueue("browser-prepare", "started", {
    id: "b".repeat(64),
  });
  h.db
    .prepare("UPDATE jobs SET state='running',lease_until=? WHERE id=?")
    .run(Date.now() + 60000, started);
  // An interrupted background job that went back to the queue is fair game.
  const interrupted = queue.enqueue("browser-prepare", "interrupted", {
    id: "e".repeat(64),
  });
  h.db.prepare("UPDATE jobs SET attempts=1 WHERE id=?").run(interrupted);
  const worker = new MediaWorker(h.db, "http://127.0.0.1:9", "c".repeat(64), {
    directory: dir,
    dataDir: dir,
    production: false,
  });
  await worker.queueLibrary();
  expect(
    (
      h.db.prepare("SELECT id FROM jobs ORDER BY rowid").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id),
  ).toEqual([asked, started]);
});

it("accepts a capability report over the API and rejects a malformed one", async () => {
  const h = await plannerFixture(film({}), "Film.mp4");
  const s = issueSession(h.db, "owner");
  const headers = {
    cookie: `mov_session=${s.token}`,
    origin: "http://localhost:4310",
    "x-csrf-token": s.csrf,
  };
  const request = (capabilities: unknown) =>
    h.app.inject({
      method: "POST",
      url: "/api/playback",
      headers,
      payload: { movieId: "m", profileId: "web", capabilities },
    });
  for (const bad of [
    { video: ["h264"], audio: ["aac"] },
    { video: ["h264; rm -rf"], audio: [], containers: [] },
    { video: Array(7).fill("h264"), audio: [], containers: [] },
    "everything",
  ])
    expect((await request(bad)).statusCode).toBe(400);
  // Reaches the planner: the fixture has no Drive, so the source check answers 503.
  expect((await request(modern)).statusCode).not.toBe(400);
});

async function hevcFixture(hdr: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "ravan-copy-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "text.srt"),
    "1\n00:00:00,100 --> 00:00:01,500\nسلام cinema\n",
  );
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
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-i",
      join(dir, "text.srt"),
      "-t",
      "2",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:s",
      "-c:v",
      "libx265",
      "-x265-params",
      "pools=1:frame-threads=1:log-level=error" +
        (hdr
          ? ":colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"
          : ""),
      // Tag the frames themselves; newer FFmpeg ignores the output colour flags.
      ...(hdr
        ? [
            "-vf",
            "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
          ]
        : ["-pix_fmt", "yuv420p"]),
      "-c:a",
      "ac3",
      "-c:s",
      "srt",
      input,
    ],
    new AbortController().signal,
    20000,
  );
  return {
    dir,
    input,
    probe: await probeMedia(input, new AbortController().signal),
  };
}

it.each([
  ["8-bit", false],
  ["10-bit HDR", true],
])(
  "repackages a real %s HEVC film without touching the picture",
  async (_name, hdr) => {
    const f = await hevcFixture(hdr);
    expect(f.probe.video).toMatchObject({ codec: "hevc", hdr });
    const out = join(f.dir, "ready");
    const result = await prepareBrowser(
      f.input,
      out,
      f.probe,
      "auto",
      0,
      new AbortController().signal,
      {
        maxBytes: 8 * 1024 ** 2,
        videoCaps: modern.video,
        verify: async () => {},
      },
    );
    const output = await probeMedia(
      join(out, "video.mp4"),
      new AbortController().signal,
    );
    // Same codec, bit depth and HDR signalling as the source; audio made AAC.
    expect(output.video).toMatchObject({
      codec: "hevc",
      pixelFormat: f.probe.video!.pixelFormat,
      hdr,
      width: 160,
      height: 90,
    });
    expect(output.audio[0]?.codec).toBe("aac");
    expect(result.label).toContain("Original picture");
    expect(await readFile(join(out, "subtitle-0.vtt"), "utf8")).toContain(
      "سلام cinema",
    );
    const bytes = await readFile(join(out, "video.mp4"));
    // Apple players require the hvc1 sample entry, and the index up front.
    expect(bytes.includes(Buffer.from("hvc1"))).toBe(true);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
    // A client that did not report HEVC still gets H.264 from the same source.
    const universal = join(f.dir, "universal");
    await prepareBrowser(
      f.input,
      universal,
      f.probe,
      "auto",
      0,
      new AbortController().signal,
      {
        maxBytes: 8 * 1024 ** 2,
        forceEncode: hdr ? false : true,
        verify: async () => {},
      },
    ).then(
      async () =>
        expect(
          (
            await probeMedia(
              join(universal, "video.mp4"),
              new AbortController().signal,
            )
          ).video,
        ).toMatchObject({ codec: "h264", pixelFormat: "yuv420p", hdr: false }),
      (error: unknown) => {
        // Tone mapping needs FFmpeg's zscale filter, which this machine may lack.
        if (!hdr) throw error;
      },
    );
  },
);
