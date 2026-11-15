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
/**
 * What identifies a file's bytes. Drive's `version` rises with any change to
 * the file's record, not only its content (it was seen to rise several times
 * an hour on films no one had touched), so it is the last resort: the
 * checksum first, then the head revision.
 */
export function contentKey(
  file: Pick<DriveFile, "size" | "md5Checksum" | "headRevisionId" | "version">,
) {
  if (file.md5Checksum) return `md5:${file.md5Checksum}:${file.size}`;
  if (file.headRevisionId) return `rev:${file.headRevisionId}:${file.size}`;
  return `version:${file.version}:${file.size}`;
}
/** True when stored Drive metadata describes the same bytes as `file`. */
export function sameContent(stored: string | undefined, file: DriveFile) {
  if (!stored) return false;
  try {
    const before = JSON.parse(stored) as Partial<DriveFile>;
    return (
      typeof before.size === "string" &&
      contentKey(before as DriveFile) === contentKey(file)
    );
  } catch {
    return false;
  }
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
