import { readdir, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
try {
  const directory = "/var/backups/ravan";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  execFileSync(
    process.execPath,
    [
      new URL("./backup.mjs", import.meta.url).pathname,
      "--destination",
      join(directory, `daily-${stamp}.ravan`),
    ],
    { stdio: "inherit" },
  );
  // Only rotate artifacts created by this job, and only after a new backup succeeds.
  const backups = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (f) =>
        f.isFile() && /^daily-\d{4}-\d{2}-\d{2}T[\d-]+Z\.ravan$/.test(f.name),
    )
    .map((f) => f.name)
    .sort()
    .reverse();
  for (const filename of backups.slice(14))
    await unlink(join(directory, filename));
} catch {
  console.error(
    "Scheduled backup failed; check private configuration and storage.",
  );
  process.exitCode = 1;
}
