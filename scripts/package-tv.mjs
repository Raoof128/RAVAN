import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const option = (name) =>
  args.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  if (option("platform") !== "webos")
    throw new Error("This milestone packages the LG webOS target only.");
  const origin = new URL(option("origin") ?? "");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    /localhost|example\.|\.test$|\.invalid$/.test(origin.hostname)
  )
    throw new Error("Supply the final HTTPS origin.");
  const result = spawnSync("npm", ["run", "build:tv"], {
    env: { ...process.env, VITE_MOV_ORIGIN: origin.origin },
    stdio: "inherit",
    shell: false,
    timeout: 120000,
  });
  if (result.error || result.status !== 0) throw new Error("TV build failed.");
  await cp("apps/tv/webos/appinfo.json", "apps/tv/dist/appinfo.json");
  await cp("apps/tv/webos/icon.png", "apps/tv/dist/icon.png");
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(js|json|html|css)$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        if (
          /-----BEGIN .*PRIVATE KEY-----|ya29\.[A-Za-z0-9_-]{20,}|GOOGLE_CLIENT_SECRET=/.test(
            text,
          )
        )
          throw new Error("Secret-like content found in package.");
      }
    }
  }
  await inspect("apps/tv/dist");
  if (args.includes("--validate-only"))
    console.log(
      "LG build validated. Hardware installation remains unverified.",
    );
  else {
    await mkdir(".local/packages", { recursive: true });
    const packaged = spawnSync(
      "ares-package",
      ["apps/tv/dist", "--outdir", ".local/packages"],
      { stdio: "inherit", shell: false, timeout: 60000 },
    );
    if (packaged.error || packaged.status !== 0)
      throw new Error(
        "LG packaging failed. Install/configure the vendor CLI first.",
      );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "TV packaging failed.",
  );
  process.exitCode = 1;
}
