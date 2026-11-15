import { expect, it } from "vitest";
import { choosePlayback } from "../../apps/api/src/media/planner.js";
import { subtitleToVtt } from "../../apps/worker/src/subtitles.js";
const probe = {
  durationMs: 10000,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
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
it("prefers compatible direct play and queues automatic HDR conversion", () => {
  expect(choosePlayback(probe, "web").mode).toBe("direct");
  expect(
    choosePlayback(
      { ...probe, video: { ...probe.video, codec: "hevc", hdr: true } },
      "web",
    ),
  ).toEqual({
    mode: "prepare",
    reason: "Preparing a compatible browser edition.",
  });
});
it("requires preparation for unsupported audio and refuses unknown profiles", () => {
  expect(
    choosePlayback({ ...probe, audio: [{ codec: "dts", channels: 6 }] }, "web")
      .mode,
  ).toBe("prepare");
  expect(choosePlayback(probe, "unknown").mode).toBe("unsupported");
});
it("converts safe text cues with RTL content and rejects unsafe timing", () => {
  const output = subtitleToVtt(
    "1\n00:00:01,000 --> 00:00:03,000\nسلام <script>alert(1)</script>\n",
  );
  expect(output).toContain("WEBVTT");
  expect(output).toContain("سلام");
  expect(output).not.toContain("<script>");
  expect(() =>
    subtitleToVtt("1\n00:00:03,000 --> 00:00:01,000\nbad"),
  ).toThrow();
});
it("explains a worker resource limit without claiming a corrupt or encrypted source", async () => {
  const { preparationFailureReason } =
    await import("../../apps/api/src/media/planner.js");
  expect(preparationFailureReason("media_resources")).toContain(
    "server reached a processing limit",
  );
  expect(preparationFailureReason("media_source")).toContain("Google Drive");
  expect(preparationFailureReason("media_storage")).toContain("storage");
  expect(preparationFailureReason(null)).not.toContain("encrypted");
});
