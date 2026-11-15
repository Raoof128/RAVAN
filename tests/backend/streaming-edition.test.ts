import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import { prepareBrowser } from "../../apps/worker/src/browser-prepare.js";
import { conversionPlan } from "../../apps/worker/src/compatibility.js";
import {
  parsePlaylist,
  readPlaylist,
  validateEdition,
} from "../../apps/worker/src/hls.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const idle = () => new AbortController().signal;
async function film(codec: string, seconds = 20, extra: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "ravan-hls-"));
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
      "testsrc2=size=160x90:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-i",
      join(dir, "text.srt"),
      "-t",
      String(seconds),
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:s",
      "-c:v",
      codec,
      "-g",
      "48",
      "-pix_fmt",
      "yuv420p",
      ...extra,
      "-c:a",
      "ac3",
      "-c:s",
      "srt",
      input,
    ],
    idle(),
    30000,
  );
  return { dir, input, probe: await probeMedia(input, idle()) };
}

it.each([
  ["a repackaged H.264 film", "libx264", true],
  ["a re-encoded MPEG-4 film", "mpeg4", false],
])(
  "writes %s as a complete, strictly-formed HLS edition",
  async (_n, codec, copy) => {
    const f = await film(codec);
    const out = join(f.dir, "edition");
    let playable = 0;
    const result = await prepareBrowser(
      f.input,
      out,
      f.probe,
      "auto",
      0,
      idle(),
      {
        maxBytes: 16 * 1024 ** 2,
        format: "hls",
        playable: () => playable++,
        verify: async () => {},
      },
    );
    expect(result.format).toBe("hls");
    expect(conversionPlan(f.probe, "auto").copyVideo).toBe(copy);
    const playlist = await validateEdition(out);
    expect(playlist.ended).toBe(true);
    expect(playlist.segments.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(playlist.seconds - 20)).toBeLessThan(1);
    // Only the playlist, the initialization segment, the segments and the captions.
    const files = (await readdir(out)).sort();
    expect(files).toEqual(
      [
        "index.m3u8",
        "init.mp4",
        ...playlist.segments.map((s) => s.file),
        "subtitle-0.vtt",
      ].sort(),
    );
    expect(await readFile(join(out, "subtitle-0.vtt"), "utf8")).toContain(
      "سلام cinema",
    );
    expect(Number(result.sizeBytes)).toBeGreaterThan(1000);
    // Offered for playback once, before or as it finished.
    expect(playable).toBe(1);
    // No temporary files or staging directory are left.
    await expect(stat(out + ".partial")).rejects.toThrow();
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
  },
);

it("removes a streamed edition that fails, is cancelled or outgrows its budget", async () => {
  const f = await film("mpeg4", 6);
  for (const mode of ["changed", "cancel", "budget"]) {
    const out = join(f.dir, mode),
      controller = new AbortController();
    if (mode === "cancel") controller.abort();
    await expect(
      prepareBrowser(f.input, out, f.probe, "auto", 0, controller.signal, {
        maxBytes: mode === "budget" ? 4096 : 16 * 1024 ** 2,
        format: "hls",
        verify: async () => {
          if (mode === "changed") throw Error("changed");
        },
      }),
    ).rejects.toThrow();
    await expect(stat(out)).rejects.toThrow();
  }
});

it("serves only a playlist made of its own tags and numbered local segments", () => {
  const good = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:6.000000,",
    "seg-00000.m4s",
    "#EXTINF:5.500000,",
    "seg-00001.m4s",
  ];
  const growing = parsePlaylist(good.join("\n") + "\n");
  expect(growing).toMatchObject({ ended: false, seconds: 11.5 });
  expect(growing.segments.map((s) => s.file)).toEqual([
    "seg-00000.m4s",
    "seg-00001.m4s",
  ]);
  expect(parsePlaylist([...good, "#EXT-X-ENDLIST"].join("\r\n")).ended).toBe(
    true,
  );
  const withLine = (line: string, at = good.length) => [
    ...good.slice(0, at),
    line,
    ...good.slice(at),
  ];
  for (const bad of [
    // Anything a player would fetch from somewhere else.
    withLine("#EXTINF:6.0,").concat("https://evil.example/seg-00002.m4s"),
    withLine("#EXTINF:6.0,").concat("../other/seg-00002.m4s"),
    withLine("#EXTINF:6.0,").concat("/etc/passwd"),
    withLine("#EXTINF:6.0,").concat("seg-00002.ts"),
    withLine('#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"', 7),
    withLine('#EXT-X-MAP:URI="https://evil.example/init.mp4"', 7),
    withLine('#EXT-X-MEDIA:TYPE=AUDIO,URI="other.m3u8"', 7),
    withLine("#EXT-X-STREAM-INF:BANDWIDTH=1", 7),
    // Structure.
    withLine("seg-00002.m4s"),
    withLine("#EXTINF:6.0,"),
    [...good, "#EXT-X-ENDLIST", "#EXTINF:6.0,", "seg-00002.m4s"],
    good.slice(1),
    good.filter((line) => !line.startsWith("#EXT-X-MAP")),
  ])
    expect(() => parsePlaylist(bad.join("\n")), bad.at(-1)).toThrow();
  expect(() =>
    parsePlaylist("#EXTM3U\n" + "#".repeat(3 * 1024 * 1024)),
  ).toThrow();
});

it("reports an edition as incomplete until its playlist is closed and whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-hls-"));
  dirs.push(dir);
  expect(await readPlaylist(dir)).toBeUndefined();
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:6.0,",
    "seg-00000.m4s",
  ];
  await writeFile(join(dir, "index.m3u8"), lines.join("\n"));
  await writeFile(join(dir, "init.mp4"), "init");
  await writeFile(join(dir, "seg-00000.m4s"), "segment");
  await expect(validateEdition(dir)).rejects.toThrow(/Incomplete/);
  await writeFile(
    join(dir, "index.m3u8"),
    [...lines, "#EXT-X-ENDLIST"].join("\n"),
  );
  expect((await validateEdition(dir)).segments).toHaveLength(1);
  await writeFile(join(dir, "seg-00000.m4s"), "");
  await expect(validateEdition(dir)).rejects.toThrow(/segment/);
});

it("sizes a re-encode of sideways footage for the picture as shown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-hls-"));
  dirs.push(dir);
  const flat = join(dir, "flat.mp4"),
    input = join(dir, "phone.mp4");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-t",
      "2",
      "-c:v",
      "mpeg4",
      flat,
    ],
    idle(),
    30000,
  );
  await runProcess(
    "ffmpeg",
    ["-v", "error", "-display_rotation", "90", "-i", flat, "-c", "copy", input],
    idle(),
    30000,
  );
  const probe = await probeMedia(input, idle());
  expect(probe.video).toMatchObject({ width: 320, height: 180, rotated: true });
  expect(conversionPlan(probe, "auto")).toMatchObject({
    width: 180,
    height: 320,
  });
  const out = join(dir, "ready");
  await prepareBrowser(input, out, probe, "auto", 0, idle(), {
    maxBytes: 16 * 1024 ** 2,
    verify: async () => {},
  });
  expect(
    (await probeMedia(join(out, "video.mp4"), idle())).video,
  ).toMatchObject({
    width: 180,
    height: 320,
  });
});
