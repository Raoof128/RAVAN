import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import {
  FULL_SCAN_INTERVAL_MS,
  LibrarySync,
  VERIFY_REUSE_MS,
} from "../../apps/api/src/drive/sync.js";
import {
  DriveError,
  type DriveClient,
  type DriveFile,
} from "../../apps/api/src/drive/client.js";
import { DriveSourceReader } from "../../apps/api/src/media/source-stream.js";
import { BlockCache } from "../../apps/api/src/media/cache.js";
import { sendRaw } from "../../apps/api/src/media/raw-route.js";

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const content = "0123456789".repeat(4);
/** A library whose film sits one folder below the root, with every Drive call counted. */
async function library(folders = 1) {
  const dir = await mkdtemp(join(tmpdir(), "mov-efficiency-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const folder = "application/vnd.google-apps.folder";
  const files: DriveFile[] = [
    { id: "root", name: "Films", mimeType: folder, parents: [] },
    ...Array.from({ length: folders }, (_unused, i) => ({
      id: `folder${i}`,
      name: `Shelf ${i}`,
      mimeType: folder,
      parents: ["root"],
    })),
    {
      id: "film",
      name: "Film.mp4",
      mimeType: "video/mp4",
      parents: ["folder0"],
      size: String(content.length),
      version: "1",
    },
  ];
  const calls = { get: 0, list: 0, startToken: 0, changes: 0 };
  let changed = false;
  const client: DriveClient = {
    get: async (id) => {
      calls.get++;
      return { ...files.find((f) => f.id === id)! };
    },
    list: async (parent) => {
      calls.list++;
      return { files: files.filter((f) => f.parents?.includes(parent)) };
    },
    startToken: async () => {
      calls.startToken++;
      return "start";
    },
    changes: async () => {
      calls.changes++;
      const result = { changed, newStartPageToken: "next" };
      changed = false;
      return result;
    },
  };
  const total = () => calls.get + calls.list + calls.startToken + calls.changes;
  return {
    dir,
    db,
    files,
    calls,
    client,
    total,
    reset: () =>
      Object.assign(calls, { get: 0, list: 0, startToken: 0, changes: 0 }),
    change: () => {
      changed = true;
    },
  };
}
const idle = new AbortController().signal;

it("verifies a streamed source once per block instead of three times", async () => {
  const f = await library();
  const sync = new LibrarySync(f.db, f.client);
  await sync.syncLibrary("root", idle);
  const reader = new DriveSourceReader(
    async () => "token",
    (id, fresh) => sync.verifySource(id, fresh),
    async (_url, init) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(
        new Headers(init?.headers).get("range")!,
      )!;
      return new Response(content.slice(Number(a), Number(b) + 1), {
        status: 206,
        headers: { "content-range": `bytes ${a}-${b}/${content.length}` },
      });
    },
  );
  const cache = new BlockCache(
    f.db,
    join(f.dir, "cache"),
    { maxBytes: 1024n, minFreeBytes: 0n, blockSize: 4 },
    (ref, start, end, signal) => reader.block(ref, start, end, signal),
  );
  await cache.init();
  const app = Fastify();
  clean.push(() => app.close());
  // Mirrors the /_worker/source wiring in apps/api/src/app.ts.
  app.get("/", async (request, reply) => {
    const ref = await sync.verifySource("film");
    return sendRaw(request, reply, ref, cache, async () => {
      await sync.verifySource(ref.fileId);
    });
  });
  f.reset();
  const response = await app.inject("/");
  expect(response.body).toBe(content);
  const blocks = content.length / 4;
  // One verification is three lookups here: the file, the root and one ancestor.
  // Before reuse this route made 99 lookups for 10 blocks; it now makes 33.
  expect(f.calls.get).toBeLessThanOrEqual((blocks + 1) * 3);
  // Every block is still confirmed by an answer obtained after its bytes were read.
  expect(f.calls.get).toBeGreaterThanOrEqual(blocks * 3);
});

it("reuses a Drive answer only briefly and never past a local revocation", async () => {
  const f = await library();
  let now = 1000000;
  const sync = new LibrarySync(f.db, f.client, () => now);
  await sync.syncLibrary("root", idle);
  f.reset();
  await sync.verifySource("film");
  expect(f.calls.get).toBe(3);
  await sync.verifySource("film");
  expect(f.calls.get).toBe(3);
  await sync.verifySource("film", true);
  expect(f.calls.get).toBe(6);
  now += VERIFY_REUSE_MS;
  await sync.verifySource("film");
  expect(f.calls.get).toBe(9);
  // The catalogue is consulted on every call, so revocation does not wait for expiry.
  f.db.prepare("UPDATE source_files SET available=0 WHERE id='film'").run();
  await expect(sync.verifySource("film")).rejects.toThrow(/unavailable/);
  expect(f.calls.get).toBe(9);
});

it("does not reuse an answer for another generation, another folder or a failure", async () => {
  const f = await library();
  const sync = new LibrarySync(f.db, f.client);
  await sync.syncLibrary("root", idle);
  await sync.verifySource("film");
  f.reset();
  // The catalogue now expects a generation Drive has not confirmed.
  f.db
    .prepare("UPDATE source_files SET generation='other' WHERE id='film'")
    .run();
  await expect(sync.verifySource("film")).rejects.toThrow(/changed/);
  expect(f.calls.get).toBeGreaterThan(0);
  expect(
    f.db.prepare("SELECT available FROM source_files WHERE id='film'").get(),
  ).toEqual({ available: 0 });

  const g = await library();
  const second = new LibrarySync(g.db, g.client);
  await second.syncLibrary("root", idle);
  await second.verifySource("film");
  g.files.find((file) => file.id === "film")!.parents = ["elsewhere"];
  g.reset();
  // Still inside the reuse window: a fresh check must see the move and fail,
  // and that failure must not be handed to the next caller as a success.
  await expect(second.verifySource("film", true)).rejects.toThrow(/changed/);
  await expect(second.verifySource("film")).rejects.toThrow(/unavailable/);
});

it("refreshes an unchanged library from the change feed without re-listing folders", async () => {
  const f = await library(20);
  let now = 1000000;
  const sync = new LibrarySync(f.db, f.client, () => now);
  await sync.syncLibrary("root", idle);
  expect(f.total()).toBe(24);
  f.reset();
  expect(await sync.syncLibrary("root", idle, { incremental: true })).toEqual({
    upserts: 1,
    unavailable: 0,
  });
  // Root lookup plus one change-feed page, instead of 24 calls every minute.
  expect(f.calls).toEqual({ get: 1, list: 0, startToken: 0, changes: 1 });

  // Any reported change falls back to a complete scan and republishes.
  f.files.push({
    id: "second",
    name: "Second.mkv",
    mimeType: "video/x-matroska",
    parents: ["folder3"],
    size: "9",
    version: "1",
  });
  f.change();
  f.reset();
  expect(
    (await sync.syncLibrary("root", idle, { incremental: true })).upserts,
  ).toBe(2);
  expect(f.calls.list).toBe(21);

  // An owner-requested sync never takes the shortcut.
  f.reset();
  await sync.syncLibrary("root", idle);
  expect(f.calls.list).toBe(21);

  // Nor does the schedule trust the feed indefinitely.
  now += FULL_SCAN_INTERVAL_MS;
  f.reset();
  await sync.syncLibrary("root", idle, { incremental: true });
  expect(f.calls.list).toBe(21);
});

it("scans fully after a failed scan and still notices a lost root when refreshing", async () => {
  const f = await library(2);
  const sync = new LibrarySync(f.db, f.client);
  await sync.syncLibrary("root", idle);
  const list = f.client.list;
  f.client.list = async () => {
    throw new Error("network");
  };
  await expect(sync.syncLibrary("root", idle)).rejects.toThrow();
  f.client.list = list;
  f.reset();
  await sync.syncLibrary("root", idle, { incremental: true });
  expect(f.calls.list).toBe(3);

  f.files.find((file) => file.id === "root")!.trashed = true;
  await expect(
    sync.syncLibrary("root", idle, { incremental: true }),
  ).rejects.toThrow(/folder/);
  expect(sync.status().state).toBe("failed");
});

it("keeps a good checkpoint when the change-feed check itself fails transiently", async () => {
  const f = await library(3);
  const sync = new LibrarySync(f.db, f.client);
  await sync.syncLibrary("root", idle);
  const changes = f.client.changes;
  f.client.changes = async () => {
    throw new DriveError(503);
  };
  f.reset();
  await expect(
    sync.syncLibrary("root", idle, { incremental: true }),
  ).rejects.toThrow();
  // No enumeration was attempted and the published state is untouched.
  expect(f.calls.list).toBe(0);
  expect(sync.status()).toMatchObject({
    state: "succeeded",
    counts: { upserts: 1, unavailable: 0 },
  });
  f.client.changes = changes;
  f.reset();
  await sync.syncLibrary("root", idle, { incremental: true });
  expect(f.calls).toEqual({ get: 1, list: 0, startToken: 0, changes: 1 });
});

it("falls back to a full scan when Drive refuses the stored change token", async () => {
  const f = await library(3);
  const sync = new LibrarySync(f.db, f.client);
  await sync.syncLibrary("root", idle);
  const changes = f.client.changes;
  let refused = false;
  f.client.changes = async (token, signal) => {
    if (!refused) {
      refused = true;
      throw new DriveError(400);
    }
    return changes(token, signal);
  };
  f.reset();
  await sync.syncLibrary("root", idle, { incremental: true });
  expect(f.calls.list).toBe(4);
  expect(sync.status().state).toBe("succeeded");
});

it("does not close a generation published while an older check was in flight", async () => {
  const f = await library();
  const sync = new LibrarySync(f.db, f.client);
  await sync.syncLibrary("root", idle);
  f.db
    .prepare(
      "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,epoch,lease_until,access_until,expires_at) SELECT 'new','ticket',movie_id,id,'published',1,9e15,9e15,9e15 FROM source_files WHERE id='film'",
    )
    .run();
  const get = f.client.get;
  f.client.get = async (id, signal) => {
    const file = await get(id, signal);
    if (id === "film") {
      // The owner replaced the file, and a scan published it mid-verification.
      file.version = "2";
      f.db
        .prepare(
          "UPDATE source_files SET generation='published' WHERE id='film'",
        )
        .run();
    }
    return file;
  };
  await expect(sync.verifySource("film", true)).rejects.toThrow(/changed/);
  expect(
    f.db.prepare("SELECT available FROM source_files WHERE id='film'").get(),
  ).toEqual({ available: 1 });
  expect(
    f.db.prepare("SELECT revoked_at FROM playback_sessions").get(),
  ).toEqual({ revoked_at: null });
});
