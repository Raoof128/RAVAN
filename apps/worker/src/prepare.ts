import { mkdir, rm, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Probe } from "./probe.js";
import { runProcess } from "./process.js";
import { validateOutput } from "./output-validation.js";
export type PrepareOptions = {
  input: string;
  output: string;
  probe: Probe;
  sourceBytes: bigint;
  inputBudget: bigint;
  outputBoundaryVerified: boolean;
  verifyGeneration?: () => Promise<void>;
};
export async function prepareMedia(
  options: PrepareOptions,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (options.sourceBytes > options.inputBudget)
    throw new Error("Input staging budget exceeded");
  if (!options.outputBoundaryVerified)
    throw new Error("Enforced output boundary required");
  if (options.probe.video?.hdr) throw new Error("HDR conversion disabled");
  if (!options.probe.video) throw new Error("Video track missing");
  const input = await stat(options.input);
  if (!input.isFile()) throw new Error("Input must be a staged file");
  const temporary = `${options.output}.${randomUUID()}.partial`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const height = Math.min(options.probe.video.height, 1080);
    await runProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,webm,mpegts,avi",
        "-i",
        options.input,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-vf",
        `scale=-2:${height % 2 === 0 ? height : height - 1}`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-force_key_frames",
        "expr:gte(t,n_forced*6)",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        join(temporary, "segment%05d.ts"),
        join(temporary, "index.m3u8"),
      ],
      signal,
      24 * 3600000,
    );
    await validateOutput(temporary);
    await options.verifyGeneration?.();
    signal.throwIfAborted();
    await rename(temporary, options.output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
