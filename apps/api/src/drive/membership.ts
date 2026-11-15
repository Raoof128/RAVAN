import { createHash } from "node:crypto";
import type { DriveClient, DriveFile } from "./client.js";
export const folderMime = "application/vnd.google-apps.folder";
export async function belongsTo(
  client: DriveClient,
  file: DriveFile,
  root: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (file.trashed || file.mimeType === "application/vnd.google-apps.shortcut")
    return false;
  const queue = [...(file.parents ?? [])],
    seen = new Set<string>();
  while (queue.length) {
    signal?.throwIfAborted();
    const id = queue.shift()!;
    if (id === root) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 128) throw new Error("Folder depth limit");
    const parent = await client.get(id, signal);
    if (!parent.trashed && parent.mimeType === folderMime)
      queue.push(...(parent.parents ?? []));
  }
  return false;
}
export function generation(file: DriveFile) {
  if (!file.size || !file.version)
    throw new Error("Source metadata incomplete");
  return createHash("sha256")
    .update(
      JSON.stringify([
        file.id,
        file.version,
        file.size,
        file.md5Checksum ?? "",
      ]),
    )
    .digest("hex");
}
