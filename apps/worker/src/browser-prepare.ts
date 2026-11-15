import { mkdir, rm, rename, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.js";
import { probeMedia, type Probe } from "./probe.js";
import {
  conversionPlan,
  boundedBitrate,
  inputFormats,
  type Quality,
} from "./compatibility.js";
export type Caption = { file: string; language: string; label: string };
export async function prepareBrowser(
  input: string,
  output: string,
  probe: Probe,
  quality: Quality,
  audio: number,
  signal: AbortSignal,
  options: {
    headers?: string;
    maxBytes: number;
    forceEncode?: boolean;
    progress?: (percent: number) => void;
    verify: () => Promise<void>;
  },
) {
  const plan = conversionPlan(probe, quality, options.forceEncode);
  if (audio < 0 || audio >= Math.max(1, probe.audio.length))
    throw Error("Audio track unavailable");
  const bitrate = plan.copyVideo
    ? plan.bitrate
    : boundedBitrate(plan.bitrate, options.maxBytes, probe.durationMs);
  const partial = output + ".partial";
  await mkdir(partial, { mode: 0o700 });
  try {
    const filters: string[] = [];
    if (plan.toneMap)
      filters.push(
        // Resize before float tone mapping to bound memory for 4K sources.
        `zscale=w=${plan.width}:h=${plan.height}:t=linear:npl=100`,
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=mobius:desat=2",
        "zscale=t=bt709:m=bt709:r=tv",
      );
    if (!plan.copyVideo)
      filters.push(
        `scale=${plan.width}:${plan.height}:flags=lanczos`,
        "setsar=1",
        "format=yuv420p",
      );
    const selected = probe.audio[audio];
    const captions: Caption[] = [];
    const textCodecs = new Set([
      "subrip",
      "srt",
      "ass",
      "ssa",
      "webvtt",
      "mov_text",
      "text",
    ]);
    for (const [i, s] of probe.subtitles.entries())
      if (
        textCodecs.has(s.codec) &&
        s.index !== undefined &&
        captions.length < 64
      )
        captions.push({
          file: `subtitle-${i}.vtt`,
          language: (s.language ?? "und").slice(0, 32),
          label: (s.title ?? s.language ?? `Captions ${i + 1}`).slice(0, 100),
        });
    const args = [
      "-nostdin",
      "-v",
      "error",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-protocol_whitelist",
      "file,http,tcp",
      "-format_whitelist",
      inputFormats,
      ...(options.headers ? ["-headers", options.headers] : []),
      "-i",
      input,
      "-map",
      "0:v:0",
      ...(selected ? ["-map", `0:a:${audio}`] : []),
      "-sn",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-c:v",
      plan.copyVideo ? "copy" : "libx264",
      ...(!plan.copyVideo
        ? [
            "-threads",
            "1",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-maxrate",
            `${bitrate}k`,
            "-bufsize",
            `${bitrate * 2}k`,
            "-vf",
            filters.join(","),
            "-pix_fmt",
            "yuv420p",
          ]
        : []),
      ...(selected
        ? [
            "-c:a",
            plan.copyVideo && selected.codec === "aac" && selected.channels <= 2
              ? "copy"
              : "aac",
            ...(plan.copyVideo &&
            selected.codec === "aac" &&
            selected.channels <= 2
              ? []
              : ["-ac", "2", "-ar", "48000", "-b:a", "192k"]),
          ]
        : []),
      "-movflags",
      "+faststart",
      "-fs",
      String(options.maxBytes),
      "-f",
      "mp4",
      join(partial, "video.mp4"),
    ];
    for (const c of captions) {
      const index = Number(c.file.match(/\d+/)![0]);
      args.push(
        "-map",
        `0:${probe.subtitles[index]!.index}`,
        "-vn",
        "-an",
        "-c:s",
        "webvtt",
        "-threads:s",
        "1",
        "-fs",
        "8388608",
        "-f",
        "webvtt",
        join(partial, c.file),
      );
    }
    args.push("-progress", "pipe:1", "-nostats");
    let buffer = "",
      lastUpdate = 0;
    await runProcess("ffmpeg", args, signal, 48 * 3600000, (chunk) => {
      buffer += chunk;
      if (buffer.length > 16384) throw Error("Invalid progress");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines)
        if (line.startsWith("out_time_us=")) {
          const us = Number(line.slice(12));
          if (Number.isFinite(us) && Date.now() - lastUpdate > 1000) {
            lastUpdate = Date.now();
            options.progress?.(
              Math.min(99, Math.max(0, (us / (probe.durationMs * 1000)) * 100)),
            );
          }
        }
    });
    const file = await stat(join(partial, "video.mp4"));
    if (file.size <= 0 || file.size > options.maxBytes)
      throw Error("Output budget exceeded");
    const actual = await probeMedia(join(partial, "video.mp4"), signal);
    if (
      Math.abs(actual.durationMs - probe.durationMs) > 2000 ||
      actual.video?.codec !== "h264" ||
      actual.video.pixelFormat !== "yuv420p" ||
      actual.video.hdr ||
      actual.audio.some((a) => a.codec !== "aac")
    )
      throw Error("Prepared media failed completeness or codec validation");
    for (const c of captions) {
      const s = await stat(join(partial, c.file));
      if (s.size > 8388608) throw Error("Caption too large");
      const text = await readFile(join(partial, c.file), "utf8");
      if (!text.startsWith("WEBVTT")) throw Error("Invalid caption");
    }
    await options.verify();
    signal.throwIfAborted();
    await rename(partial, output);
    return {
      sizeBytes: String(file.size),
      captions,
      label: plan.copyVideo
        ? "Original picture · compatible MP4"
        : `${plan.height}p · ${plan.toneMap ? "SDR · " : ""}H.264`,
    };
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}
