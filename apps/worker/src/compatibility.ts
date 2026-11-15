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
// Every entry is a self-contained media container or elementary stream.
export const inputFormats =
  "mov,matroska,webm,mpegts,avi,mpeg,asf,flv,ogg,rm,nut,3g2,m4v,h264,hevc,mpegvideo,vc1,mxf,wtv,dv,ivf";
/** Subtitle codecs that carry text and can become WebVTT; the rest are images. */
export const textSubtitles = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
  "text",
]);
/** Pictures that can be repackaged into MP4 untouched for a client that decodes them. */
const mp4Video = new Set(["h264", "hevc", "av1"]);
/**
 * Whether a client that reported `caps` can decode this picture as it is. Without
 * a report (a TV, an older client) only 8-bit H.264 is assumed.
 */
export function clientDecodes(
  video: NonNullable<Probe["video"]>,
  caps: readonly string[] | undefined,
): boolean {
  if (video.dolbyVisionProfile === 5) return false;
  const eight = video.pixelFormat === "yuv420p";
  const ten = video.pixelFormat === "yuv420p10le";
  switch (video.codec) {
    case "h264":
      return eight && !video.hdr;
    case "hevc":
      return Boolean(
        caps &&
        ((eight && !video.hdr && caps.includes("hevc")) ||
          (ten && caps.includes("hevc10"))),
      );
    case "av1":
      return Boolean(caps?.includes("av1") && (eight || ten));
    case "vp9":
    case "vp8":
      return Boolean(caps?.includes(video.codec) && eight && !video.hdr);
    default:
      return false;
  }
}
export function conversionPlan(
  probe: Probe,
  quality: Quality,
  forceEncode = false,
  /** Video codecs the requesting client decodes; omit for the conservative plan. */
  caps?: readonly string[],
) {
  const stored = probe.video;
  // FFmpeg turns sideways footage upright before filtering, so a re-encode is
  // sized for the picture as shown. A copy keeps the stored frames and their
  // rotation flag, and compares like with like either way.
  const v =
    stored?.rotated === true
      ? { ...stored, width: stored.height, height: stored.width }
      : stored;
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
  const size = (keep: boolean) => {
    const target = keep
      ? v.height
      : quality === "auto"
        ? 1080
        : Number.parseInt(quality);
    if (!Number.isFinite(target)) throw Error("Invalid quality");
    const maxWidth = keep
      ? Math.min(v.width, 4096)
      : Math.round((target * 16) / 9);
    const ratio = Math.min(
      1,
      target / v.height,
      maxWidth / v.width,
      4096 / v.width,
      2160 / v.height,
    );
    return {
      width: Math.max(2, Math.floor((v.width * ratio) / 2) * 2),
      height: Math.max(2, Math.floor((v.height * ratio) / 2) * 2),
    };
  };
  const unscaled = (d: { width: number; height: number }) =>
    d.width === v.width && d.height === v.height;
  // Re-encoding on a small server takes hours; repackaging takes minutes. When
  // the client can decode the source picture, Auto keeps it instead of shrinking
  // it to 1080p. An explicit size is still honoured.
  const decodable =
    !forceEncode && mp4Video.has(v.codec) && clientDecodes(v, caps);
  const { width, height } = size(
    quality === "original" ||
      (quality === "auto" && Boolean(caps) && decodable),
  );
  const copyVideo = decodable && unscaled({ width, height });
  // The plan a client that reported nothing would get for the same request.
  const plainCopy =
    !forceEncode &&
    clientDecodes(v, undefined) &&
    unscaled(size(quality === "original"));
  const toneMap = v.hdr && !copyVideo;
  // A copied picture keeps its own pixel shape. A re-encoded one is given square
  // pixels, so an anamorphic source must be widened or it plays squeezed.
  const displayWidth =
    copyVideo || !v.sar
      ? width
      : Math.max(2, Math.min(4096, Math.round((width * v.sar) / 2) * 2));
  return {
    width: displayWidth,
    height,
    deinterlace: Boolean(v.interlaced) && !copyVideo,
    toneMap,
    copyVideo,
    /**
     * Names an edition only some clients can play, so it never shares an asset
     * with the universal H.264 one. Empty for the plan every client gets.
     */
    variant: copyVideo && !plainCopy ? `copy-${v.codec}` : "",
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
