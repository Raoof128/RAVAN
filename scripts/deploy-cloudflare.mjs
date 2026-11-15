import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
try {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const manifest = JSON.parse(
    await readFile(join(root, ".local/cloudflare/manifest.json"), "utf8"),
  );
  if (
    git("status", "--porcelain") ||
    manifest.release !== git("rev-parse", "--short=12", "HEAD")
  )
    throw new Error("Commit changes and rebuild before deploying.");
  const publicDir = join(root, ".local/cloudflare/public");
  const actual = await readdir(publicDir, {
    recursive: true,
    withFileTypes: true,
  });
  if (
    actual.some((f) => !f.isFile() && !f.isDirectory()) ||
    actual.filter((f) => f.isFile()).length !== manifest.files.length
  )
    throw new Error("Release contents changed; rebuild before deploying.");
  for (const file of manifest.files) {
    const data = await readFile(join(publicDir, file.path));
    if (createHash("sha256").update(data).digest("hex") !== file.sha256)
      throw new Error("Release checksum mismatch; rebuild before deploying.");
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID for the intended account.");
  execFileSync(
    "npx",
    [
      "--yes",
      "wrangler@4.162.0",
      "deploy",
      "--var",
      `RELEASE:${manifest.release}`,
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: "inherit" },
  );
} catch (error) {
  console.error("Deployment stopped:", error.message);
  process.exitCode = 1;
}
