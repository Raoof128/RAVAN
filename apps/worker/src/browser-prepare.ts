import { mkdir, rm, rename, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.js";
import { probeMedia, type Probe } from "./probe.js";
import {
  conversionPlan,
  boundedBitrate,
  inputFormats,
  textSubtitles,
  type Quality,
} from "./compatibility.js";
import {
  directoryBytes,
  HLS_PLAYABLE_SEGMENTS,
  HLS_PLAYLIST,
  HLS_SEGMENT_SECONDS,
  readPlaylist,
  validateEdition,
} from "./hls.js";
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
    /** Encoder and decoder threads; one per CPU the service may use. */
    threads?: number;
    preset?: string;
    /** Video codecs the requesting client decodes; see conversionPlan(). */
    videoCaps?: readonly string[];
    progress?: (percent: number) => void;
    /**
     * "mp4" writes one file that plays only when finished. "hls" writes segments
     * straight into `output`, so the first of them can be played while the rest
     * are still being produced.
     */
    format?: "mp4" | "hls";
    /** Called once when enough of an "hls" edition exists to start playing. */
    playable?: () => void;
    verify: () => Promise<void>;
  },
) {
  const plan = conversionPlan(
    probe,
    quality,
    options.forceEncode,
    options.videoCaps,
  );
  if (audio < 0 || audio >= Math.max(1, probe.audio.length))
    throw Error("Audio track unavailable");
  const bitrate = plan.copyVideo
    ? plan.bitrate
    : boundedBitrate(plan.bitrate, options.maxBytes, probe.durationMs);
  const streaming = options.format === "hls";
  // A streamed edition is served from its final place while it grows; the
  // caller decides when it may be offered and removes it if this fails.
  const partial = streaming ? output : output + ".partial";
  await mkdir(partial, { mode: 0o700 });
  let finished = false;
  try {
    const threads = String(Math.max(1, Math.floor(options.threads ?? 1)));
    const filters: string[] = [];
    // Only frames flagged as interlaced are touched; the rest pass through.
    if (plan.deinterlace)
      filters.push("bwdif=mode=send_frame:deint=interlaced");
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
    for (const [i, s] of probe.subtitles.entries())
      if (
        textSubtitles.has(s.codec) &&
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
      threads,
      "-filter_threads",
      threads,
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
      // Apple players only accept HEVC in MP4 under the hvc1 sample entry.
      ...(plan.copyVideo && probe.video?.codec === "hevc"
        ? ["-tag:v", "hvc1"]
        : []),
      ...(!plan.copyVideo
        ? [
            "-threads",
            threads,
            "-preset",
            options.preset ?? "superfast",
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
      ...(streaming
        ? [
            // Segments must start on a keyframe. A copied picture is cut at the
            // keyframes it has; an encoded one is given one per segment.
            ...(plan.copyVideo
              ? []
              : [
                  "-force_key_frames",
                  `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
                ]),
            "-f",
            "hls",
            "-hls_time",
            String(HLS_SEGMENT_SECONDS),
            // Append-only until finished, then closed with an end marker.
            "-hls_playlist_type",
            "event",
            "-hls_segment_type",
            "fmp4",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-hls_segment_filename",
            join(partial, "seg-%05d.m4s"),
            // temp_file: a segment and the playlist appear only when complete.
            "-hls_flags",
            "independent_segments+temp_file",
            join(partial, HLS_PLAYLIST),
          ]
        : [
            "-movflags",
            "+faststart",
            "-fs",
            String(options.maxBytes),
            "-f",
            "mp4",
            join(partial, "video.mp4"),
          ]),
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
    // The HLS muxer has no size limit of its own, and its playlist decides when
    // playback may begin. Both are checked on their own clock, not on FFmpeg's
    // progress reports, and an overrun stops FFmpeg at once. The volume itself
    // is the hard limit; this keeps one edition from taking all of it.
    const limiter = new AbortController();
    let stopped: Error | undefined,
      checking = false,
      announced = false;
    const inspect = async () => {
      if (checking || stopped) return;
      checking = true;
      try {
        if ((await directoryBytes(partial)) > options.maxBytes)
          throw Error("Output budget exceeded");
        const playlist = await readPlaylist(partial);
        if (
          !announced &&
          playlist &&
          (playlist.ended || playlist.segments.length >= HLS_PLAYABLE_SEGMENTS)
        ) {
          announced = true;
          options.playable?.();
        }
      } catch (error) {
        stopped = error instanceof Error ? error : Error("Invalid output");
        limiter.abort();
      } finally {
        checking = false;
      }
    };
    const watch = streaming
      ? setInterval(() => void inspect(), 1000)
      : undefined;
    watch?.unref();
    const run = runProcess(
      "ffmpeg",
      args,
      AbortSignal.any([signal, limiter.signal]),
      48 * 3600000,
      (chunk) => {
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
                Math.min(
                  99,
                  Math.max(0, (us / (probe.durationMs * 1000)) * 100),
                ),
              );
            }
          }
      },
    );
    await run
      .catch((error: unknown) => {
        throw stopped ?? error;
      })
      .finally(() => clearInterval(watch));
    // One last look: the final segments may have landed since the last tick.
    if (streaming) {
      await inspect();
      if (stopped) throw stopped;
    }
    let bytes: number;
    if (streaming) {
      const playlist = await validateEdition(partial);
      if (Math.abs(playlist.seconds * 1000 - probe.durationMs) > 2000)
        throw Error("Prepared media failed completeness or codec validation");
      bytes = await directoryBytes(partial);
    } else bytes = (await stat(join(partial, "video.mp4"))).size;
    if (bytes <= 0 || bytes > options.maxBytes)
      throw Error("Output budget exceeded");
    // The playlist was just validated as this server's own, local output.
    const actual = streaming
      ? await probeMedia(
          join(partial, HLS_PLAYLIST),
          signal,
          undefined,
          "hls,mov",
        )
      : await probeMedia(join(partial, "video.mp4"), signal);
    // A copied picture must come out as it went in; an encoded one as H.264 SDR.
    const expected = plan.copyVideo
      ? probe.video!
      : { codec: "h264", pixelFormat: "yuv420p", hdr: false };
    if (
      Math.abs(actual.durationMs - probe.durationMs) > 2000 ||
      actual.video?.codec !== expected.codec ||
      actual.video.pixelFormat !== expected.pixelFormat ||
      actual.video.hdr !== expected.hdr ||
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
    if (!streaming) await rename(partial, output);
    // A short film can finish before the first check ran.
    else if (!announced) options.playable?.();
    finished = true;
    return {
      sizeBytes: String(bytes),
      captions,
      format: streaming ? ("hls" as const) : ("mp4" as const),
      label: plan.copyVideo
        ? streaming
          ? "Original picture · repackaged"
          : "Original picture · compatible MP4"
        : `${plan.height}p · ${plan.toneMap ? "SDR · " : ""}H.264`,
    };
  } finally {
    // Nothing incomplete is left behind in either layout.
    if (!streaming || !finished)
      await rm(partial, { recursive: true, force: true });
  }
}
