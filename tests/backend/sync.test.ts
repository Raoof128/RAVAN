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
    const client = createDriveClient(async () => "private", fake);
    await expect(client.get("root")).rejects.toThrow();
    expect(calls).toBe(status >= 429 ? 3 : 1);
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
