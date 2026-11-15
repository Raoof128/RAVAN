import { z } from "zod";
import { inputFormats } from "./compatibility.js";
import { runProcess } from "./process.js";
export type Probe = {
  durationMs: number;
  container: string;
  video?: {
    codec: string;
    pixelFormat: string;
    width: number;
    height: number;
    hdr: boolean;
    transfer?: string;
    dolbyVisionProfile?: number;
    /** Pixel width over height when pixels are not square (DVD, broadcast). */
    sar?: number;
    /** Fields rather than whole frames (DVD, broadcast recordings). */
    interlaced?: boolean;
    /** Stored sideways (phone footage): shown rotated by a quarter turn. */
    rotated?: boolean;
  };
  audio: Array<{
    codec: string;
    channels: number;
    index?: number;
    language?: string;
    title?: string;
    /** The container marks this track as the one to play by default. */
    default?: boolean;
  }>;
  subtitles: Array<{
    codec: string;
    language?: string;
    index?: number;
    title?: string;
  }>;
};
/**
 * Bump when a probe starts recording something planning depends on, so films
 * inspected earlier are inspected again. 3 added the default audio track, pixel
 * shape, interlacing and rotation.
 */
export const PROBE_VERSION = 3;
const text = z.string().max(256);
/** The shape a stored probe must have before the worker builds a command from it. */
export const probeRecord = z.object({
  generation: z.string().max(128),
  version: z.number().optional(),
  probe: z.object({
    durationMs: z.number().positive(),
    container: text,
    video: z
      .object({
        codec: text,
        pixelFormat: text,
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        hdr: z.boolean(),
        transfer: text.optional(),
        dolbyVisionProfile: z.number().optional(),
        sar: z.number().positive().optional(),
        interlaced: z.boolean().optional(),
        rotated: z.boolean().optional(),
      })
      .optional(),
    audio: z
      .array(
        z.object({
          codec: text,
          channels: z.number().nonnegative(),
          index: z.number().int().nonnegative().optional(),
          language: z.string().optional(),
          title: z.string().optional(),
          default: z.boolean().optional(),
        }),
      )
      .max(100),
    subtitles: z
      .array(
        z.object({
          codec: text,
          language: z.string().optional(),
          index: z.number().int().nonnegative().optional(),
          title: z.string().optional(),
        }),
      )
      .max(100),
  }),
});
const stream = z.object({
  codec_type: z.string(),
  index: z.number().int().nonnegative().optional(),
  side_data_list: z
    .array(
      z
        .object({
          dv_profile: z.number().optional(),
          rotation: z.number().optional(),
        })
        .passthrough(),
    )
    .optional(),
  codec_name: z.string().optional(),
  pix_fmt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  channels: z.number().optional(),
  color_transfer: z.string().optional(),
  sample_aspect_ratio: z.string().optional(),
  field_order: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  disposition: z.object({ default: z.number().optional() }).optional(),
});
function shape(video: z.infer<typeof stream>) {
  const [n, d] = (video.sample_aspect_ratio ?? "").split(":").map(Number);
  const sar = n && d ? n / d : 1;
  return {
    // Ignore rounding noise and absurd values; both mean square pixels here.
    ...(Math.abs(sar - 1) > 0.01 && sar > 0.25 && sar < 4 ? { sar } : {}),
    ...(["tt", "bb", "tb", "bt"].includes(video.field_order ?? "")
      ? { interlaced: true }
      : {}),
    ...(video.side_data_list?.some(
      (side) => Math.abs((side.rotation ?? 0) % 180) === 90,
    )
      ? { rotated: true }
      : {}),
  };
}
export async function probeMedia(
  input: string,
  signal: AbortSignal,
  headers?: string,
  /** Demuxers FFprobe may use; widened only for this server's own output. */
  formats = inputFormats,
): Promise<Probe> {
  const raw = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-probesize",
      "5000000",
      "-analyzeduration",
      "5000000",
      "-protocol_whitelist",
      "file,http,tcp",
      "-format_whitelist",
      formats,
      ...(headers ? ["-headers", headers] : []),
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      input,
    ],
    signal,
    30000,
  );
  const data = z
    .object({
      streams: z.array(stream).max(100),
      format: z.object({
        format_name: z.string(),
        duration: z.string().optional(),
      }),
    })
    .parse(JSON.parse(raw));
  const video = data.streams.find((s) => s.codec_type === "video");
  const durationMs = Number(data.format.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    throw new Error("Unknown media duration");
  return {
    durationMs,
    container: data.format.format_name,
    ...(video
      ? {
          video: {
            codec: video.codec_name ?? "unknown",
            transfer: video.color_transfer,
            dolbyVisionProfile: video.side_data_list?.find(
              (s) => s.dv_profile !== undefined,
            )?.dv_profile,
            pixelFormat: video.pix_fmt ?? "unknown",
            width: video.width ?? 0,
            height: video.height ?? 0,
            hdr: ["smpte2084", "arib-std-b67"].includes(
              video.color_transfer ?? "",
            ),
            ...shape(video),
          },
        }
      : {}),
    audio: data.streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => ({
        codec: s.codec_name ?? "unknown",
        channels: s.channels ?? 0,
        index: s.index,
        language: s.tags?.language,
        title: s.tags?.title,
        ...(s.disposition?.default ? { default: true } : {}),
      })),
    subtitles: data.streams
      .filter((s) => s.codec_type === "subtitle")
      .map((s) => ({
        codec: s.codec_name ?? "unknown",
        language: s.tags?.language,
        index: s.index,
        title: s.tags?.title,
      })),
  };
}
