import type { Probe } from "./probe.js";
export const qualities = [
  "auto",
  "original",
  "480p",
  "720p",
  "1080p",
  "1440p",
  "2160p",
] as const;
export type Quality = (typeof qualities)[number];
// Do not allow playlist/image demuxers to turn media bytes into extra network or file reads.
export const inputFormats =
  "mov,matroska,webm,mpegts,avi,mpeg,asf,flv,ogg,rm,nut,3g2,m4v,h264,hevc";
export function conversionPlan(
  probe: Probe,
  quality: Quality,
  forceEncode = false,
) {
  const v = probe.video;
  if (
    !v ||
    v.width < 2 ||
    v.height < 2 ||
    v.width > 8192 ||
    v.height > 8192 ||
    !Number.isFinite(probe.durationMs) ||
    probe.durationMs <= 0 ||
    probe.durationMs > 48 * 3600000
  )
    throw Error("Unsupported video dimensions or duration");
  if (v.dolbyVisionProfile === 5)
    throw Error(
      "Dolby Vision-only content requires a compatible base-layer edition",
    );
  const target =
    quality === "original"
      ? v.height
      : quality === "auto"
        ? 1080
        : Number.parseInt(quality);
  if (!Number.isFinite(target)) throw Error("Invalid quality");
  const maxWidth =
    quality === "original"
      ? Math.min(v.width, 4096)
      : Math.round((target * 16) / 9);
  const ratio = Math.min(
    1,
    target / v.height,
    maxWidth / v.width,
    4096 / v.width,
    2160 / v.height,
  );
  const width = Math.max(2, Math.floor((v.width * ratio) / 2) * 2),
    height = Math.max(2, Math.floor((v.height * ratio) / 2) * 2);
  const toneMap = v.hdr;
  const copyVideo =
    !forceEncode &&
    v.codec === "h264" &&
    v.pixelFormat === "yuv420p" &&
    !toneMap &&
    width === v.width &&
    height === v.height;
  return {
    width,
    height,
    toneMap,
    copyVideo,
    copyAudio:
      probe.audio.length === 0 ||
      probe.audio.every((a) => a.codec === "aac" && a.channels <= 2),
    bitrate:
      height <= 480
        ? 1800
        : height <= 720
          ? 3500
          : height <= 1080
            ? 6500
            : height <= 1440
              ? 11000
              : 18000,
  };
}

export function boundedBitrate(
  targetKbps: number,
  maxBytes: number,
  durationMs: number,
) {
  // Reserve 10% for muxing, rate-control bursts and captions; AAC is192kbit/s.
  const budgetKbps = Math.floor(
    ((maxBytes * 0.9 * 8) / (durationMs / 1000) - 192000) / 1000,
  );
  if (!Number.isFinite(budgetKbps) || budgetKbps < 256)
    throw Error("Output budget too small for complete video");
  return Math.min(targetKbps, budgetKbps);
}
