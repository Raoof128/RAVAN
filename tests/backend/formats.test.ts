import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import { prepareBrowser } from "../../apps/worker/src/browser-prepare.js";
import { conversionPlan } from "../../apps/worker/src/compatibility.js";
import { isVideoFile } from "../../apps/api/src/drive/sync.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const idle = () => new AbortController().signal;
async function make(file: string, video: string[], audio: string[] | null) {
  const dir = await mkdtemp(join(tmpdir(), "ravan-format-"));
  dirs.push(dir);
  const input = join(dir, file);
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=352x288:rate=25",
      ...(audio
        ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
        : []),
      "-t",
      "2",
      ...video,
      ...(audio ?? []),
      input,
    ],
    idle(),
    30000,
  );
  return { dir, input };
}
async function convert(dir: string, input: string) {
  const probe = await probeMedia(input, idle());
  const out = join(dir, "ready");
  await prepareBrowser(input, out, probe, "auto", 0, idle(), {
    maxBytes: 16 * 1024 ** 2,
    verify: async () => {},
  });
  return { probe, output: await probeMedia(join(out, "video.mp4"), idle()) };
}

// One real file per container and codec family a personal library is likely to hold.
it.each([
  [
    "AVI, DivX-style MPEG-4 and MP3",
    "film.avi",
    ["-c:v", "msmpeg4"],
    ["-c:a", "libmp3lame"],
  ],
  [
    "transport stream, MPEG-2 and AC-3",
    "film.ts",
    ["-c:v", "mpeg2video"],
    ["-c:a", "ac3"],
  ],
  [
    "DVD VOB, MPEG-2 and AC-3",
    "film.vob",
    ["-c:v", "mpeg2video", "-f", "vob"],
    ["-c:a", "ac3"],
  ],
  [
    "MPEG program stream, MPEG-1 and MP2",
    "film.mpg",
    ["-c:v", "mpeg1video"],
    ["-c:a", "mp2"],
  ],
  [
    "Windows Media, WMV and WMA",
    "film.wmv",
    ["-c:v", "wmv2"],
    ["-c:a", "wmav2"],
  ],
  [
    "Flash video and MP3",
    "film.flv",
    ["-c:v", "flv"],
    ["-c:a", "libmp3lame", "-ar", "44100"],
  ],
  [
    "QuickTime, ProRes and PCM",
    "film.mov",
    ["-c:v", "prores"],
    ["-c:a", "pcm_s16le"],
  ],
  ["WebM, VP8 and Opus", "film.webm", ["-c:v", "libvpx"], ["-c:a", "libopus"]],
  [
    "Ogg, VP8 and Opus",
    "film.ogv",
    ["-c:v", "libvpx", "-f", "ogg"],
    ["-c:a", "libopus"],
  ],
  [
    "Matroska, AV1 and FLAC",
    "film.mkv",
    ["-c:v", "libsvtav1"],
    ["-c:a", "flac"],
  ],
  [
    "Matroska, 10-bit H.264 and E-AC-3",
    "film.mkv",
    ["-c:v", "libx264", "-pix_fmt", "yuv420p10le"],
    ["-c:a", "eac3"],
  ],
  [
    "Matroska, VP9 and DTS",
    "film.mkv",
    ["-c:v", "libvpx-vp9"],
    ["-c:a", "dca", "-strict", "-2"],
  ],
  ["NUT, MPEG-4 and MP2", "film.nut", ["-c:v", "mpeg4"], ["-c:a", "mp2"]],
  [
    "MXF, MPEG-2 and PCM",
    "film.mxf",
    ["-c:v", "mpeg2video"],
    ["-c:a", "pcm_s16le"],
  ],
  [
    "Windows TV recording, MPEG-2 and AC-3",
    "film.wtv",
    ["-c:v", "mpeg2video"],
    ["-c:a", "ac3"],
  ],
  ["IVF, VP8 without audio", "film.ivf", ["-c:v", "libvpx"], null],
] as const)(
  "converts %s into a browser edition",
  async (_name, file, video, audio) => {
    const f = await make(file, [...video], audio ? [...audio] : null);
    expect(
      isVideoFile({ name: file, mimeType: "application/octet-stream" }),
    ).toBe(true);
    const { probe, output } = await convert(f.dir, f.input);
    expect(probe.video?.codec).not.toBe("h264_never");
    expect(output.video).toMatchObject({
      codec: "h264",
      pixelFormat: "yuv420p",
      width: 352,
      height: 288,
    });
    expect(output.audio.map((a) => a.codec)).toEqual(audio ? ["aac"] : []);
    expect(Math.abs(output.durationMs - probe.durationMs)).toBeLessThan(2000);
  },
);

it("widens an anamorphic source so it is not played squeezed", async () => {
  // PAL DVD: 720x576 stored, meant to be shown 16:9.
  const dir = await mkdtemp(join(tmpdir(), "ravan-format-"));
  dirs.push(dir);
  const input = join(dir, "dvd.vob");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=720x576:rate=25",
      "-t",
      "1",
      "-c:v",
      "mpeg2video",
      "-aspect",
      "16:9",
      "-f",
      "vob",
      input,
    ],
    idle(),
    30000,
  );
  const { probe, output } = await convert(dir, input);
  expect(probe.video?.sar).toBeCloseTo(64 / 45, 2);
  expect(conversionPlan(probe, "auto")).toMatchObject({
    width: 1024,
    height: 576,
  });
  expect(output.video).toMatchObject({ width: 1024, height: 576 });
  expect(output.video?.sar).toBeUndefined();
});

it("deinterlaces a source that says it is interlaced, and only then", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-format-"));
  dirs.push(dir);
  const input = join(dir, "broadcast.ts");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=720x576:rate=50",
      "-t",
      "1",
      "-vf",
      "interlace,setfield=tff",
      "-c:v",
      "mpeg2video",
      "-flags",
      "+ilme+ildct",
      input,
    ],
    idle(),
    30000,
  );
  const { probe, output } = await convert(dir, input);
  expect(probe.video?.interlaced).toBe(true);
  expect(conversionPlan(probe, "auto").deinterlace).toBe(true);
  expect(output.video?.interlaced).toBeUndefined();
  // A progressive source, and a picture copied untouched, are left alone.
  expect(
    conversionPlan(
      { ...probe, video: { ...probe.video!, interlaced: undefined } },
      "auto",
    ).deinterlace,
  ).toBe(false);
});

it("recognizes the wider set of video file names and still refuses playlists and images", () => {
  for (const name of [
    "a.divx",
    "a.f4v",
    "a.mxf",
    "a.wtv",
    "a.m2t",
    "a.ogm",
    "a.vro",
    "a.MK3D",
  ])
    expect(isVideoFile({ name, mimeType: "application/octet-stream" })).toBe(
      true,
    );
  for (const name of ["a.m3u8", "a.jpg", "a.srt", "a.iso", "a.rar", "a.exe"])
    expect(isVideoFile({ name, mimeType: "application/octet-stream" })).toBe(
      false,
    );
});

it("refuses to open a playlist or image disguised as a film", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-format-"));
  dirs.push(dir);
  const { writeFile } = await import("node:fs/promises");
  // A playlist could make the converter fetch other URLs or local files.
  await writeFile(
    join(dir, "film.mkv"),
    "#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n",
  );
  await expect(probeMedia(join(dir, "film.mkv"), idle())).rejects.toThrow();
  await writeFile(
    join(dir, "list.mp4"),
    "ffconcat version 1.0\nfile /etc/passwd\n",
  );
  await expect(probeMedia(join(dir, "list.mp4"), idle())).rejects.toThrow();
});
