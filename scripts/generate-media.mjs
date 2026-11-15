import { mkdir } from "node:fs/promises";
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
