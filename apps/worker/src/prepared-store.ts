import {
  stat,
  statfs,
  mkdir,
  readdir,
  rm,
  realpath,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "../../../packages/db/src/open.js";
export const CAPACITY = 20 * 1024 ** 3;
export const ASSET_ID = /^[a-f0-9]{64}$/;
export function assetId(
  source: string,
  generation: string,
  quality: string,
  audio: number,
  forceEncode = false,
  /** From conversionPlan(); empty keeps the identity older assets were given. */
  variant = "",
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "browser-v1",
        source,
        generation,
        quality,
        audio,
        forceEncode,
        ...(variant ? [variant] : []),
      ]),
    )
    .digest("hex");
}
export async function verifyBoundary(
  directory: string,
  dataDir: string,
  production: boolean,
  capacity = CAPACITY,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== resolve(directory))
    throw Error("Prepared storage must be a real directory");
  const [target, root, space] = await Promise.all([
    stat(directory),
    stat(dataDir),
    statfs(directory, { bigint: true }),
  ]);
  if (
    production &&
    (target.dev === root.dev ||
      space.blocks * space.bsize > BigInt(capacity) ||
      space.blocks * space.bsize < 1024n ** 3n)
  )
    throw Error("Enforced preparation filesystem required");
  const rootSpace = await statfs(dataDir, { bigint: true });
  if (production && rootSpace.bavail * rootSpace.bsize < 30n * 1024n ** 3n)
    throw Error("Root storage reserve unavailable");
  return space;
}
/** Free space kept beyond an edition's own room. */
export const ROOM_RESERVE = 256 * 1024 ** 2;
/**
 * Room an edition is given before it starts: a copy needs about the source's
 * size; an encode its bitrate for the film's length. Never less than 64 MiB,
 * and never more than the volume less a margin for its neighbours.
 */
export function editionBytes(input: {
  copyVideo: boolean;
  bitrateKbps: number;
  durationMs: number;
  sourceBytes: number;
  capacity: number;
}) {
  const largest = Math.max(1024 ** 3, input.capacity - 2 * 1024 ** 3);
  const estimate = input.copyVideo
    ? input.sourceBytes * 1.05
    : ((((input.bitrateKbps * 1000) / 8 + 24000) * input.durationMs) / 1000) *
      1.15;
  return Math.ceil(Math.min(largest, Math.max(64 * 1024 ** 2, estimate)));
}
/**
 * The finished editions that would be evicted, oldest use first, to give an
 * edition `needed` bytes; undefined when evicting everything that is not
 * being watched would still not be enough.
 */
export function roomPlan(
  db: Database,
  available: number,
  needed: number,
  now = Date.now(),
) {
  const rows = db
    .prepare(
      "SELECT id,source_id sourceId,size_bytes size FROM prepared_assets WHERE state='ready' AND id NOT IN (SELECT asset_id FROM playback_sessions WHERE revoked_at IS NULL AND lease_until>? AND asset_id IS NOT NULL) ORDER BY last_used",
    )
    .all(now) as Array<{ id: string; sourceId: string; size: string | null }>;
  const evicted: Array<{ id: string; sourceId: string }> = [];
  let room = available;
  for (const row of rows) {
    if (room > needed + ROOM_RESERVE) break;
    evicted.push({ id: row.id, sourceId: row.sourceId });
    room += Number(row.size ?? 0);
  }
  return room > needed + ROOM_RESERVE ? evicted : undefined;
}
export async function makeRoom(
  db: Database,
  directory: string,
  needed: number,
) {
  // Incomplete outputs from an interrupted previous lease are never served. One
  // conversion runs at a time and this precedes it, so anything still marked as
  // in progress is left over from an attempt that died.
  db.prepare(
    "UPDATE prepared_assets SET state='queued' WHERE state IN ('preparing','streaming')",
  ).run();
  for (const name of await readdir(directory))
    if (
      /^[a-f0-9]{64}\.partial$/.test(name) ||
      (ASSET_ID.test(name) &&
        !db
          .prepare("SELECT 1 FROM prepared_assets WHERE id=? AND state='ready'")
          .get(name))
    )
      await rm(join(directory, name), { recursive: true, force: true });
  const available = async () => {
    const s = await statfs(directory, { bigint: true });
    return Number(s.bavail * s.bsize);
  };
  // Evict nothing unless evicting can make enough room: otherwise films would
  // be lost for an edition that still could not be made.
  if (!roomPlan(db, await available(), needed))
    throw Error("Prepared storage full");
  // Single leased worker owns cleanup. Never evict an asset referenced by a live session.
  const rows = db
    .prepare(
      "SELECT id FROM prepared_assets WHERE state='ready' AND id NOT IN (SELECT asset_id FROM playback_sessions WHERE revoked_at IS NULL AND lease_until>? AND asset_id IS NOT NULL) ORDER BY last_used",
    )
    .all(Date.now()) as { id: string }[];
  for (const row of rows) {
    if ((await available()) > needed + ROOM_RESERVE) break;
    if (!ASSET_ID.test(row.id)) throw Error("Invalid asset");
    // This conditional update and session creation serialize on SQLite's writer lock.
    const removed = db
      .prepare(
        "UPDATE prepared_assets SET state='evicted' WHERE id=? AND state='ready' AND NOT EXISTS (SELECT 1 FROM playback_sessions WHERE asset_id=? AND revoked_at IS NULL AND lease_until>?)",
      )
      .run(row.id, row.id, Date.now());
    if (!removed.changes) continue;
    await rm(join(directory, row.id), { recursive: true, force: true });
  }
  if ((await available()) <= needed + ROOM_RESERVE)
    throw Error("Prepared storage full");
}
/**
 * Remove finished editions of content that has since changed: the server
 * refuses to play them, so they only take space. Never one a live session
 * is using. Returns how many were removed.
 */
export async function pruneStale(
  db: Database,
  directory: string,
  now = Date.now(),
) {
  const stale = db
    .prepare(
      `SELECT a.id FROM prepared_assets a LEFT JOIN source_files s ON s.id=a.source_id
       WHERE a.state IN ('ready','evicted') AND (s.id IS NULL OR s.generation<>a.generation)
       AND NOT EXISTS (SELECT 1 FROM playback_sessions p WHERE p.asset_id=a.id AND p.revoked_at IS NULL AND p.lease_until>?)`,
    )
    .all(now) as { id: string }[];
  let removed = 0;
  for (const row of stale) {
    if (!ASSET_ID.test(row.id)) continue;
    const gone = db
      .prepare(
        "DELETE FROM prepared_assets WHERE id=? AND state IN ('ready','evicted') AND NOT EXISTS (SELECT 1 FROM playback_sessions WHERE asset_id=? AND revoked_at IS NULL AND lease_until>?)",
      )
      .run(row.id, row.id, now);
    if (!gone.changes) continue;
    await rm(join(directory, row.id), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
export function localReader(directory: string, file = "video.mp4") {
  return {
    async *readSource(
      source: { fileId: string },
      start: bigint,
      end: bigint,
      signal: AbortSignal,
    ) {
      if (
        !/^(video\.mp4|subtitle-\d+\.vtt|init\.mp4|seg-\d{5}\.m4s)$/.test(
          file,
        ) ||
        !ASSET_ID.test(source.fileId)
      )
        throw Error("Invalid prepared asset");
      const handle = await open(
        join(directory, source.fileId, file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const s = await handle.stat();
        if (!s.isFile()) throw Error("Invalid prepared file");
        let position = Number(start);
        const last = Number(end);
        while (position <= last) {
          signal.throwIfAborted();
          const bytes = Buffer.alloc(Math.min(256 * 1024, last - position + 1));
          const { bytesRead } = await handle.read(
            bytes,
            0,
            bytes.length,
            position,
          );
          if (!bytesRead) throw Error("Truncated prepared file");
          position += bytesRead;
          yield bytes.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    },
  };
}
