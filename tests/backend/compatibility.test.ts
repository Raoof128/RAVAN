import { expect, it } from "vitest";
import { conversionPlan } from "../../apps/worker/src/compatibility.js";
const probe = {
  durationMs: 60000,
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
};
it("automatically remuxes compatible MKV without losing picture quality", () => {
  expect(conversionPlan(probe, "auto").copyVideo).toBe(true);
  expect(conversionPlan(probe, "auto").height).toBe(1080);
});
it("converts HEVC/AV1/VP9/legacy/10-bit and non-AAC audio for browsers", () => {
  for (const codec of ["hevc", "av1", "vp9", "mpeg4", "mpeg2video", "vc1"])
    expect(
      conversionPlan({ ...probe, video: { ...probe.video, codec } }, "auto")
        .copyVideo,
    ).toBe(false);
  expect(
    conversionPlan({ ...probe, audio: [{ codec: "dts", channels: 6 }] }, "auto")
      .copyAudio,
  ).toBe(false);
  expect(
    conversionPlan(
      { ...probe, video: { ...probe.video, pixelFormat: "yuv420p10le" } },
      "auto",
    ).copyVideo,
  ).toBe(false);
});
it("never upscales and honors original or selected quality", () => {
  expect(conversionPlan(probe, "2160p").height).toBe(1080);
  expect(conversionPlan(probe, "720p").height).toBe(720);
  expect(
    conversionPlan(
      { ...probe, video: { ...probe.video, width: 3840, height: 2160 } },
      "original",
    ).height,
  ).toBe(2160);
});
it("tone maps HDR10/HLG and rejects Dolby Vision-only or invalid dimensions", () => {
  expect(
    conversionPlan(
      { ...probe, video: { ...probe.video, hdr: true, transfer: "smpte2084" } },
      "auto",
    ).toneMap,
  ).toBe(true);
  expect(() =>
    conversionPlan(
      { ...probe, video: { ...probe.video, dolbyVisionProfile: 5 } },
      "auto",
    ),
  ).toThrow(/Dolby/);
  expect(() =>
    conversionPlan({ ...probe, video: { ...probe.video, width: 0 } }, "auto"),
  ).toThrow();
});

it("bounds long 4K encodes to disk capacity instead of silently truncating", async () => {
  const { boundedBitrate } =
    await import("../../apps/worker/src/compatibility.js");
  const rate = boundedBitrate(18000, 18 * 1024 ** 3, 4 * 3600000);
  expect(rate).toBeLessThan(10000);
  expect(rate).toBeGreaterThan(5000);
  expect(() => boundedBitrate(1800, 128, 10000)).toThrow("budget");
});
