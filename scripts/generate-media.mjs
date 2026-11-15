import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".local/test-media", { recursive: true });
const result = spawnSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-y",
    ".local/test-media/synthetic.mp4",
  ],
  { stdio: "inherit", shell: false, timeout: 20000 },
);
if (result.error || result.status !== 0) {
  console.error("Synthetic fixture generation failed. Install FFmpeg first.");
  process.exitCode = 1;
}
// A streamed edition, written with the same muxer options the worker uses, so
// the browser tests exercise the real segment and playlist format.
await rm(".local/test-media/hls", { recursive: true, force: true });
await mkdir(".local/test-media/hls", { recursive: true });
const streamed = spawnSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    "24",
    "-c:v",
    "libx264",
    "-preset",
    "superfast",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    "expr:gte(t,n_forced*6)",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    ".local/test-media/hls/seg-%05d.m4s",
    "-hls_flags",
    "independent_segments+temp_file",
    ".local/test-media/hls/index.m3u8",
  ],
  { stdio: "inherit", shell: false, timeout: 30000 },
);
if (streamed.error || streamed.status !== 0) {
  console.error("Streamed fixture generation failed.");
  process.exitCode = 1;
}
