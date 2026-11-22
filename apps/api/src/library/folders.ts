import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";

/**
 * The library's Drive folders, shared by the films and the reading room: both
 * are found by the same scan of the one connected folder.
 */
export type FolderRow = { id: string; name: string; parent_id: string | null };
/** A folder of the library as the browser names it: its top is "root". */
export const ROOT = "root";
export const folderParam = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();
/** Every folder at or below `id`, as a recursive query's opening clause. */
export const subtree = `WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT f.id FROM library_folders f JOIN tree ON f.parent_id=tree.id)`;

/**
 * The folder being browsed, or undefined to list the whole library at once.
 * Until a scan has recorded the folder tree, the top of the library is the
 * whole library, as it was before folders could be browsed. Null: no such
 * folder in the library.
 */
export function placeFolder(
  db: Database,
  folder: string,
): FolderRow | null | undefined {
  const root = (
    db
      .prepare("SELECT folder_id FROM sync_checkpoints WHERE id='library'")
      .get() as { folder_id: string | null } | undefined
  )?.folder_id;
  const top = root
    ? (db
        .prepare(
          "SELECT id,name,parent_id FROM library_folders WHERE id=? AND parent_id IS NULL",
        )
        .get(root) as FolderRow | undefined)
    : undefined;
  if (!top) return folder === ROOT ? undefined : null;
  if (folder === ROOT || folder === top.id) return top;
  const row = db
    .prepare("SELECT id,name,parent_id FROM library_folders WHERE id=?")
    .get(folder) as FolderRow | undefined;
  return row && row.parent_id !== null ? row : null;
}

/** How a folder names itself and its way back, as the browser shows it. */
export function folderPlace(db: Database, folder: FolderRow) {
  const top = folder.parent_id === null;
  const parent =
    folder.parent_id === null
      ? undefined
      : (db
          .prepare("SELECT id,name,parent_id FROM library_folders WHERE id=?")
          .get(folder.parent_id) as FolderRow | undefined);
  return {
    id: top ? ROOT : folder.id,
    name: folder.name,
    parentId: top
      ? null
      : !parent || parent.parent_id === null
        ? ROOT
        : parent.id,
    ...(parent && parent.parent_id !== null ? { parentName: parent.name } : {}),
  };
}
