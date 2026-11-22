import { expect, it } from "vitest";
import Fastify from "fastify";
import { join, dirname } from "node:path";
import { BlockCache } from "../../apps/api/src/media/cache.js";
import { DriveSourceReader } from "../../apps/api/src/media/source-stream.js";
import { registerReading } from "../../apps/api/src/library/reading.js";
import { createHarness } from "../fixtures/harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import { LibrarySync, VERIFY_REUSE_MS } from "../../apps/api/src/drive/sync.js";
import type {
  DriveClient,
  DriveFile,
} from "../../apps/api/src/drive/client.js";

it("streams exact book bytes in bounded blocks and refuses stale, oversized and revoked sources", async () => {
  const h = await createHarness();
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 13, 42);
  const root: DriveFile = {
    id: "root",
    name: "Library",
    mimeType: "application/vnd.google-apps.folder",
  };
  const file: DriveFile = {
    id: "book",
    name: "Book.pdf",
    mimeType: "application/pdf",
    parents: ["root"],
    version: "1",
    size: String(bytes.length),
  };
  const client: DriveClient = {
    get: async (id) => ({ ...(id === "root" ? root : file) }),
    list: async () => ({ files: [file] }),
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
  let clock = Date.now();
  const sync = new LibrarySync(h.db, client, () => clock);
  const app = Fastify();
  let reads = 0;
  app.decorate("getDriveAccessToken", async () => "test-token");
  const reader = new DriveSourceReader(
    async () => "test-token",
    (id) => sync.verifyReading(id),
    async (url, init) => {
      expect(String(url)).toBe(
        "https://www.googleapis.com/drive/v3/files/book?alt=media",
      );
      const range = new Headers(init?.headers).get("range")!;
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
      expect(Number(b) - Number(a) + 1).toBeLessThanOrEqual(4 * 1024 * 1024);
      reads++;
      return new Response(bytes.subarray(Number(a), Number(b) + 1), {
        status: 206,
        headers: { "content-range": `${range.replace("=", " ")}/${file.size}` },
      });
    },
  );
  const cache = new BlockCache(
    h.db,
    join(dirname(h.db.name), "reader-test-cache"),
    { maxBytes: 20000000n, minFreeBytes: 0n },
    (ref, a, b, signal) => reader.block(ref, a, b, signal),
  );
  await cache.init();
  registerReading(app, h.db, sync, cache, true);
  try {
    await sync.syncLibrary("root", new AbortController().signal);
    const ref = await sync.verifyReading("book");
    const url = `/api/reading/book/content?generation=${ref.generation}`;
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(reads).toBe(2);
    const tail = await app.inject({ url, headers: { range: "bytes=-13" } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload).toEqual(bytes.subarray(-13));
    expect(tail.headers["content-range"]).toBe(
      `bytes ${bytes.length - 13}-${bytes.length - 1}/${bytes.length}`,
    );
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(
      (await app.inject(url.replace(ref.generation, "b".repeat(64))))
        .statusCode,
    ).toBe(409);
    const slices = await app.inject(url + "&slices=0,256");
    expect(slices.statusCode).toBe(200);
    expect(slices.rawPayload).toEqual(
      Buffer.concat([bytes.subarray(0, 16384), bytes.subarray(-13)]),
    );
    for (const list of [
      "1,0",
      "0,0",
      "257",
      "-1",
      "nope",
      Array.from({ length: 65 }, (_, i) => i).join(","),
    ]) {
      expect((await app.inject(url + "&slices=" + list)).statusCode).toBe(400);
    }
    file.capabilities = { canDownload: false };
    // A Drive answer may be reused for VERIFY_REUSE_MS, never longer.
    clock += VERIFY_REUSE_MS;
    expect((await app.inject(url)).statusCode).toBe(410);
    file.capabilities = { canDownload: true };
    // A PDF is oversized above 512 MB (an EPUB or CBZ above 100 MB: see
    // reading-large.test.ts).
    file.size = String(513 * 1024 * 1024);
    file.version = "2";
    await sync.syncLibrary("root", new AbortController().signal);
    const large = await sync.verifyReading("book");
    expect(
      (
        await app.inject(
          `/api/reading/book/content?generation=${large.generation}`,
        )
      ).statusCode,
    ).toBe(413);
    expect(reads).toBe(2);
  } finally {
    await app.close();
    await h.close();
  }
});

it("discovers books separately, preserves renamed progress, resets replacements and denies moves", async () => {
  const h = await createHarness();
  const root: DriveFile = {
    id: "root",
    name: "Library",
    mimeType: "application/vnd.google-apps.folder",
  };
  const book: DriveFile = {
    id: "book",
    name: "Story.epub",
    mimeType: "application/epub+zip",
    parents: ["root"],
    size: "100",
    version: "1",
    md5Checksum: "a",
  };
  const video: DriveFile = {
    ...book,
    id: "video",
    name: "Film.mp4",
    mimeType: "video/mp4",
  };
  const shortcut: DriveFile = {
    ...book,
    id: "shortcut",
    mimeType: "application/vnd.google-apps.shortcut",
  };
  const client: DriveClient = {
    get: async (id) => ({
      ...[root, book, video, shortcut].find((f) => f.id === id)!,
    }),
    list: async () => ({
      files: [
        book,
        video,
        shortcut,
        {
          id: "doc",
          name: "Draft.pdf",
          mimeType: "application/vnd.google-apps.document",
          parents: ["root"],
        },
        {
          ...book,
          id: "unnamed",
          name: "Volume 1.5",
          mimeType: "application/pdf",
        },
      ],
    }),
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
  let clock = Date.now();
  const sync = new LibrarySync(h.db, client, () => clock);
  try {
    await sync.syncLibrary("root", new AbortController().signal);
    expect(h.db.prepare("SELECT name FROM reading_items").all()).toEqual([
      { name: "Story.epub" },
      { name: "Volume 1.5" },
    ]);
    expect(h.db.prepare("SELECT title FROM movies").all()).toEqual([
      { title: "Film" },
    ]);
    const first = await sync.verifyReading("book");
    h.db.prepare("UPDATE reading_items SET section=3,fraction=0.4").run();
    book.name = "Renamed.epub";
    book.version = "2";
    await sync.syncLibrary("root", new AbortController().signal);
    expect((await sync.verifyReading("book")).generation).toBe(
      first.generation,
    );
    expect(
      h.db.prepare("SELECT section,fraction FROM reading_items").get(),
    ).toEqual({ section: 3, fraction: 0.4 });
    book.md5Checksum = "b";
    clock += VERIFY_REUSE_MS;
    await expect(sync.verifyReading("book")).rejects.toThrow();
    await sync.syncLibrary("root", new AbortController().signal);
    expect(
      h.db.prepare("SELECT section,fraction FROM reading_items").get(),
    ).toEqual({ section: 0, fraction: 0 });
    book.parents = [];
    await expect(sync.verifyReading("book")).rejects.toThrow();
    await sync.syncLibrary("root", new AbortController().signal);
    expect(h.db.prepare("SELECT available FROM reading_items").get()).toEqual({
      available: 0,
    });
  } finally {
    await h.close();
  }
});

it("protects catalogue, byte downloads and progress with authentication, CSRF and generation checks", async () => {
  const h = await createHarness();
  try {
    const session = issueSession(h.db, "owner");
    const headers = {
      cookie: `mov_session=${session.token}`,
      origin: "http://localhost:4310",
      "x-csrf-token": session.csrf,
    };
    const gen = "a".repeat(64);
    h.db
      .prepare(
        "INSERT INTO reading_items(id,name,format,generation,size_bytes,metadata) VALUES(?,?,?,?,?,?)",
      )
      .run("book", "A story.epub", "epub", gen, "100", "{}");
    for (const url of [
      "/api/reading",
      "/api/reading/book/content?generation=" + gen,
      "/%61pi/reading",
    ])
      expect((await h.app.inject(url)).statusCode).toBe(401);
    expect(
      (await h.app.inject({ url: "/api/reading", headers })).json().items[0]
        .title,
    ).toBe("A story");
    expect(
      (
        await h.app.inject({
          url: "/api/reading?q=" + encodeURIComponent("' OR 1=1--"),
          headers,
        })
      ).json().items,
    ).toEqual([]);
    expect(
      (await h.app.inject({ url: "/api/reading?offset=-1", headers }))
        .statusCode,
    ).toBe(400);
    const write = {
      method: "PUT" as const,
      url: "/api/reading/book/progress",
      payload: { generation: gen, section: 2, fraction: 0.25 },
    };
    expect(
      (await h.app.inject({ ...write, headers: { cookie: headers.cookie } }))
        .statusCode,
    ).toBe(403);
    expect((await h.app.inject({ ...write, headers })).statusCode).toBe(204);
    expect(
      (
        await h.app.inject({
          ...write,
          headers,
          payload: { ...write.payload, section: -1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app.inject({
          ...write,
          headers,
          payload: { ...write.payload, generation: "b".repeat(64) },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      h.db.prepare("SELECT section,fraction FROM reading_items").get(),
    ).toEqual({ section: 2, fraction: 0.25 });
    // Cached catalogue membership alone never grants the download.
    expect(
      (
        await h.app.inject({
          url: `/api/reading/book/content?generation=${gen}`,
          headers,
        })
      ).statusCode,
    ).toBe(410);
  } finally {
    await h.close();
  }
});
