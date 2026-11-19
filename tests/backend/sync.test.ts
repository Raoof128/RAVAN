import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../../packages/db/src/open.js";
import { LibrarySync } from "../../apps/api/src/drive/sync.js";
import {
  type DriveClient,
  type DriveFile,
  DriveError,
} from "../../apps/api/src/drive/client.js";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mov-sync-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const files: DriveFile[] = [
    {
      id: "root",
      name: "Movies",
      mimeType: "application/vnd.google-apps.folder",
      parents: [],
    },
    {
      id: "folder",
      name: "Inside",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    },
    {
      id: "one",
      name: "Same.mp4",
      mimeType: "video/mp4",
      parents: ["folder"],
      size: "20",
      version: "1",
    },
    {
      id: "two",
      name: "Same.mp4",
      mimeType: "video/mp4",
      parents: ["root"],
      size: "30",
      version: "1",
    },
    {
      id: "shortcut",
      name: "Skip",
      mimeType: "application/vnd.google-apps.shortcut",
      parents: ["root"],
    },
  ];
  let fail = false,
    repeated = false;
  const client: DriveClient = {
    get: async (id) => {
      const f = files.find((f) => f.id === id);
      if (!f) throw new DriveError(404);
      return { ...f };
    },
    list: async (parent, page) => {
      if (fail && page) throw new DriveError(503);
      const found = files.filter((f) => f.parents?.includes(parent));
      const n = Number(page ?? "0");
      return {
        files: found.slice(n, n + 1),
        nextPageToken: repeated
          ? "0"
          : n + 1 < found.length
            ? String(n + 1)
            : undefined,
      };
    },
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
  return {
    db,
    files,
    client,
    sync: new LibrarySync(db, client),
    fail: () => {
      fail = true;
    },
    repeat: () => {
      repeated = true;
    },
  };
}
function sources(db: Database) {
  return db
    .prepare("SELECT id,available,generation FROM source_files ORDER BY id")
    .all() as Array<{ id: string; available: number; generation: string }>;
}
it("imports all pages and descendants, keeps duplicate names distinct, excludes shortcuts", async () => {
  const { sync, db } = await fixture();
  expect(await sync.syncLibrary("root", new AbortController().signal)).toEqual({
    upserts: 2,
    unavailable: 0,
  });
  expect(sources(db).map((f) => f.id)).toEqual(["one", "two"]);
  await sync.syncLibrary("root", new AbortController().signal);
  expect(db.prepare("SELECT COUNT(*) n FROM movies").get()).toEqual({ n: 2 });
});
it("resumes staged pages after restart without publishing a failed scan", async () => {
  const { sync, db, client, fail } = await fixture();
  fail();
  await expect(
    sync.syncLibrary("root", new AbortController().signal),
  ).rejects.toThrow();
  expect(sources(db)).toHaveLength(0);
  client.list = async (parent) => ({
    files:
      parent === "root"
        ? [await client.get("two"), await client.get("folder")]
        : [await client.get("one")],
  });
  await new LibrarySync(db, client).syncLibrary(
    "root",
    new AbortController().signal,
  );
  expect(sources(db)).toHaveLength(2);
});
it("folder move invalidates descendants while retaining movie history", async () => {
  const { sync, files, db } = await fixture();
  await sync.syncLibrary("root", new AbortController().signal);
  const movie = (
    db.prepare("SELECT movie_id FROM source_files WHERE id='one'").get() as {
      movie_id: string;
    }
  ).movie_id;
  db.prepare("INSERT INTO progress VALUES (?, ?,1,1,12000,0,0)").run(
    movie,
    "old",
  );
  files.find((f) => f.id === "folder")!.parents = ["elsewhere"];
  await sync.syncLibrary("root", new AbortController().signal);
  expect(sources(db).find((f) => f.id === "one")!.available).toBe(0);
  expect(db.prepare("SELECT position_ms FROM progress").get()).toEqual({
    position_ms: 12000,
  });
  await expect(sync.verifySource("one")).rejects.toThrow();
});
it("marks lost permission unavailable and changes generation when replaced", async () => {
  const { sync, files, db } = await fixture();
  await sync.syncLibrary("root", new AbortController().signal);
  const before = sources(db)[0]!.generation;
  files.find((f) => f.id === "one")!.version = "2";
  files.splice(
    files.findIndex((f) => f.id === "two"),
    1,
  );
  await sync.syncLibrary("root", new AbortController().signal);
  expect(sources(db)[0]!.generation).not.toBe(before);
  expect(sources(db)[1]!.available).toBe(0);
});
it("rejects pagination loops and cancels without publishing", async () => {
  const { sync, repeat, db } = await fixture();
  repeat();
  await expect(
    sync.syncLibrary("root", new AbortController().signal),
  ).rejects.toThrow(/pagination/i);
  expect(sources(db)).toHaveLength(0);
  const controller = new AbortController();
  controller.abort();
  await expect(sync.syncLibrary("root", controller.signal)).rejects.toThrow();
});

it.each([401, 403, 429, 503])(
  "bounds Drive retries for status %s",
  async (status) => {
    const { createDriveClient } =
      await import("../../apps/api/src/drive/client.js");
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response("{}", { status });
    };
    const { DRIVE_RATE_LIMIT_ATTEMPTS } =
      await import("../../apps/api/src/drive/client.js");
    const client = createDriveClient(async () => "private", fake, 1);
    await expect(client.get("root")).rejects.toThrow();
    // A rate limit gets Google's longer backoff; a server error a short one.
    expect(calls).toBe(
      status === 429 ? DRIVE_RATE_LIMIT_ATTEMPTS : status > 429 ? 3 : 1,
    );
  },
);
it("does not publish a snapshot when changes continue during enumeration", async () => {
  const { sync, client, db } = await fixture();
  client.changes = async () => ({ changed: true, newStartPageToken: "next" });
  await expect(
    sync.syncLibrary("root", new AbortController().signal),
  ).rejects.toThrow(/changed/);
  expect(sources(db)).toHaveLength(0);
});

it("recognizes generic-MIME video uploads but excludes archives and documents", async () => {
  const { isVideoFile } = await import("../../apps/api/src/drive/sync.js");
  for (const name of ["Film.MKV", "film.avi", "film.m2ts", "film.rmvb"])
    expect(isVideoFile({ name, mimeType: "application/octet-stream" })).toBe(
      true,
    );
  for (const name of ["film.zip", "film.pdf", "film.mkv.zip"])
    expect(isVideoFile({ name, mimeType: "application/octet-stream" })).toBe(
      false,
    );
});

it("keeps the library available when the root recheck fails for a transient reason", async () => {
  const { sync, client, db } = await fixture();
  await sync.syncLibrary("root", new AbortController().signal);
  db.prepare(
    "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,epoch,lease_until,access_until,expires_at) SELECT 'live','ticket',movie_id,id,generation,1,9e15,9e15,9e15 FROM source_files WHERE id='one'",
  ).run();
  const get = client.get;
  let rootReads = 0;
  // A child page is denied, then Google briefly fails the confirming root lookup.
  client.get = async (id, signal) => {
    if (id === "root" && ++rootReads > 1) throw new DriveError(503);
    return get(id, signal);
  };
  client.list = async () => {
    throw new DriveError(404);
  };
  await expect(
    sync.syncLibrary("root", new AbortController().signal),
  ).rejects.toThrow();
  expect(sources(db).map((f) => f.available)).toEqual([1, 1]);
  expect(db.prepare("SELECT revoked_at FROM playback_sessions").get()).toEqual({
    revoked_at: null,
  });
});
it("still closes the whole library when the root itself is confirmed lost", async () => {
  const { sync, client, db } = await fixture();
  await sync.syncLibrary("root", new AbortController().signal);
  const get = client.get;
  let rootReads = 0;
  client.get = async (id, signal) => {
    if (id === "root" && ++rootReads > 1) throw new DriveError(404);
    return get(id, signal);
  };
  client.list = async () => {
    throw new DriveError(403);
  };
  await expect(
    sync.syncLibrary("root", new AbortController().signal),
  ).rejects.toThrow();
  expect(sources(db).map((f) => f.available)).toEqual([0, 0]);
});

it("keeps a film's generation when Drive raises its version without new content", async () => {
  const { sync, files, db } = await fixture();
  for (const f of files)
    if (f.id === "one" || f.id === "two") f.md5Checksum = `md5-${f.id}`;
  await sync.syncLibrary("root", new AbortController().signal);
  const before = sources(db);
  // Drive raises the version for changes to the record, not the bytes.
  for (const f of files)
    if (f.version) f.version = String(Number(f.version) + 7);
  await sync.syncLibrary("root", new AbortController().signal);
  expect(sources(db)).toEqual(before);
  // Checking the source against Drive agrees, and neither closes it nor its sessions.
  const ref = await sync.verifySource("one", true);
  expect(ref.generation).toBe(before.find((s) => s.id === "one")!.generation);
  expect(sources(db).find((s) => s.id === "one")!.available).toBe(1);
  // New content is a new generation.
  files.find((f) => f.id === "one")!.md5Checksum = "md5-replaced";
  await expect(sync.verifySource("one", true)).rejects.toThrow();
  await sync.syncLibrary("root", new AbortController().signal);
  expect(sources(db).find((s) => s.id === "one")!.generation).not.toBe(
    before.find((s) => s.id === "one")!.generation,
  );
  // Without a checksum, the head revision identifies the content.
  const two = files.find((f) => f.id === "two")!;
  delete two.md5Checksum;
  two.headRevisionId = "rev-1";
  await sync.syncLibrary("root", new AbortController().signal);
  const settled = sources(db).find((s) => s.id === "two")!.generation;
  two.version = "99";
  await sync.syncLibrary("root", new AbortController().signal);
  expect(sources(db).find((s) => s.id === "two")!.generation).toBe(settled);
});
