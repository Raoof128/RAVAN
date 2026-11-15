import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  mkdir,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import { prepareBrowser } from "../../apps/worker/src/browser-prepare.js";
import {
  localReader,
  verifyBoundary,
} from "../../apps/worker/src/prepared-store.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture(codec = "libx264", hdr = false, subtitleCount = 1) {
  const dir = await mkdtemp(join(tmpdir(), "ravan-prepare-"));
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
      ...Array.from({ length: subtitleCount }, () => ["-map", "2:s"]).flat(),
      "-c:v",
      codec,
      "-threads",
      "1",
      ...(codec === "libx265"
        ? [
            "-x265-params",
            "pools=1:frame-threads=1:log-level=error" +
              (hdr
                ? ":colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"
                : ""),
          ]
        : []),
      ...(hdr
        ? [
            "-pix_fmt",
            "yuv420p10le",
            "-color_trc",
            "smpte2084",
            "-color_primaries",
            "bt2020",
            "-colorspace",
            "bt2020nc",
          ]
        : ["-pix_fmt", "yuv420p"]),
      "-c:a",
      "ac3",
      "-c:s",
      "srt",
      "-metadata:s:s:0",
      "language=fas",
      input,
    ],
    new AbortController().signal,
    15000,
  );
  return {
    dir,
    input,
    probe: await probeMedia(input, new AbortController().signal),
  };
}
it.each(["libx264", "mpeg4", "libvpx-vp9"])(
  "prepares %s MKV with AAC, Persian WebVTT and a seekable complete MP4",
  async (codec) => {
    const f = await fixture(codec);
    const out = join(f.dir, "ready");
    const result = await prepareBrowser(
      f.input,
      out,
      f.probe,
      "auto",
      0,
      new AbortController().signal,
      { maxBytes: 8 * 1024 ** 2, verify: async () => {} },
    );
    const probe = await probeMedia(
      join(out, "video.mp4"),
      new AbortController().signal,
    );
    expect(probe.video).toMatchObject({
      codec: "h264",
      pixelFormat: "yuv420p",
      width: 160,
      height: 90,
      hdr: false,
    });
    expect(probe.audio[0]?.codec).toBe("aac");
    expect(result.captions).toHaveLength(1);
    expect(await readFile(join(out, "subtitle-0.vtt"), "utf8")).toContain(
      "سلام cinema",
    );
    const bytes = await readFile(join(out, "video.mp4"));
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
    expect(probe.durationMs).toBeGreaterThan(1900);
  },
);
it.skipIf(
  !execFileSync("ffmpeg", ["-hide_banner", "-filters"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).includes(" zscale "),
)("tone maps a 10-bit HDR source into 8-bit SDR", async () => {
  const f = await fixture("libx265", true);
  expect(f.probe.video?.hdr).toBe(true);
  const out = join(f.dir, "ready");
  const result = await prepareBrowser(
    f.input,
    out,
    f.probe,
    "auto",
    0,
    new AbortController().signal,
    { maxBytes: 8 * 1024 ** 2, verify: async () => {} },
  );
  expect(result.label).toContain("SDR");
  expect(
    (await probeMedia(join(out, "video.mp4"), new AbortController().signal))
      .video?.hdr,
  ).toBe(false);
});
it("never publishes truncated, cancelled or changed-generation outputs", async () => {
  const f = await fixture("mpeg4");
  for (const mode of ["budget", "cancel", "changed"]) {
    const out = join(f.dir, mode),
      c = new AbortController();
    if (mode === "cancel") c.abort();
    await expect(
      prepareBrowser(f.input, out, f.probe, "auto", 0, c.signal, {
        maxBytes: mode === "budget" ? 128 : 8 * 1024 ** 2,
        verify: async () => {
          if (mode === "changed") throw Error("changed");
        },
      }),
    ).rejects.toThrow();
    await expect(stat(out)).rejects.toThrow();
    await expect(stat(out + ".partial")).rejects.toThrow();
  }
});
it("refuses an unbounded production filesystem and symlinked media", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-store-"));
  dirs.push(dir);
  await expect(
    verifyBoundary(await realpath(dir), await realpath(dir), true),
  ).rejects.toThrow("Enforced");
  const id = "a".repeat(64);
  await mkdir(join(dir, id));
  await writeFile(join(dir, "outside"), "secret");
  await symlink(join(dir, "outside"), join(dir, id, "video.mp4"));
  const reader = localReader(dir);
  await expect(async () => {
    for await (const chunk of reader.readSource(
      { fileId: id },
      0n,
      2n,
      new AbortController().signal,
    ))
      void chunk;
  }).rejects.toThrow();
});

it("prepares all64 text subtitle tracks without dropping captions", async () => {
  const f = await fixture("libx264", false, 64),
    out = join(f.dir, "many-captions");
  expect(f.probe.subtitles).toHaveLength(64);
  const result = await prepareBrowser(
    f.input,
    out,
    f.probe,
    "auto",
    0,
    new AbortController().signal,
    { maxBytes: 8 * 1024 ** 2, verify: async () => {} },
  );
  expect(result.captions).toHaveLength(64);
  for (const caption of result.captions)
    expect(await readFile(join(out, caption.file), "utf8")).toContain(
      "سلام cinema",
    );
  expect(
    (await probeMedia(join(out, "video.mp4"), new AbortController().signal))
      .video?.codec,
  ).toBe("h264");
});
