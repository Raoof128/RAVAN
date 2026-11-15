import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  cp,
  rename,
  access,
} from "node:fs/promises";
import { resolve, join, extname, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".local/cloudflare");
try {
  await mkdir(work, { recursive: true });
  const stage = await mkdtemp(join(work, "stage-"));
  const publicDir = join(stage, "public");
  const demoDir = join(stage, "demo");
  for (const [mode, base, output] of [
    ["cloudflare", "/", publicDir],
    ["public-demo", "/demo/", demoDir],
  ]) {
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
        "--mode",
        mode,
        "--base",
        base,
        "--outDir",
        output,
        "--emptyOutDir",
      ],
      { cwd: join(root, "apps/web"), stdio: "inherit" },
    );
  }
  await cp(demoDir, join(publicDir, "demo"), { recursive: true });
  await writeFile(
    join(publicDir, "_headers"),
    `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  X-Robots-Tag: noindex, nofollow
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' blob: https://media.example.com; connect-src 'self' https://media.example.com; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
`,
  );
  await writeFile(
    join(publicDir, "robots.txt"),
    "User-agent: *\nDisallow: /\n",
  );
  const allowed = new Set([
    ".html",
    ".js",
    ".css",
    ".svg",
    ".webp",
    ".png",
    ".woff",
    ".woff2",
    ".txt",
  ]);
  const files = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      if (
        !entry.isFile() ||
        (entry.name !== "_headers" && !allowed.has(extname(path)))
      )
        throw new Error(
          "Unexpected release file: " + relative(publicDir, path),
        );
      const data = await readFile(path);
      if (
        [".html", ".js", ".css", ".txt"].includes(extname(path)) &&
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}/.test(
          data.toString(),
        )
      )
        throw new Error("Credential-pattern check failed in release");
      files.push({
        path: relative(publicDir, path),
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
  }
  await scan(publicDir);
  const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  const release = revision + (dirty ? "-worktree" : "");
  const destination = join(work, "public");
  let exists = false;
  try {
    await access(destination);
    exists = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (exists) await rename(destination, join(work, "previous-" + Date.now()));
  await rename(publicDir, destination);
  await writeFile(
    join(work, "manifest.json"),
    JSON.stringify(
      { release, createdAt: new Date().toISOString(), files },
      null,
      2,
    ) + "\n",
  );
  console.log(`Prepared ${files.length} public assets for ${release}`);
} catch (error) {
  console.error("Cloudflare build failed:", error.message);
  process.exitCode = 1;
}
