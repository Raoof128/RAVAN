import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
export async function validateOutput(directory: string) {
  const manifest = await readFile(join(directory, "index.m3u8"), "utf8");
  if (
    manifest.length > 1024 * 1024 ||
    !manifest.startsWith("#EXTM3U") ||
    !manifest.includes("#EXT-X-ENDLIST")
  )
    throw new Error("Incomplete VOD manifest");
  const uris = manifest
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"));
  if (!uris.length) throw new Error("Empty manifest");
  for (const uri of uris) {
    if (!/^segment\d{5}\.ts$/.test(uri)) throw new Error("Unsafe manifest URI");
    const file = await lstat(join(directory, uri));
    if (!file.isFile() || file.isSymbolicLink() || file.size === 0)
      throw new Error("Missing media segment");
  }
  if (/URI=/.test(manifest)) throw new Error("Unexpected nested manifest URI");
  return uris;
}
