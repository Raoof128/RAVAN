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
  };
  audio: Array<{
    codec: string;
    channels: number;
    index?: number;
    language?: string;
    title?: string;
  }>;
  subtitles: Array<{
    codec: string;
    language?: string;
    index?: number;
    title?: string;
  }>;
};
const stream = z.object({
  codec_type: z.string(),
  index: z.number().int().nonnegative().optional(),
  side_data_list: z
    .array(z.object({ dv_profile: z.number().optional() }).passthrough())
    .optional(),
  codec_name: z.string().optional(),
  pix_fmt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  channels: z.number().optional(),
  color_transfer: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
export async function probeMedia(
  input: string,
  signal: AbortSignal,
  headers?: string,
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
      inputFormats,
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
