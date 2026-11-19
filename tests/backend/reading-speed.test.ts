import { expect, it } from "vitest";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { BlockCache } from "../../apps/api/src/media/cache.js";
import { DriveSourceReader } from "../../apps/api/src/media/source-stream.js";
import {
  BOOK_BLOCK_PARTS,
  OPEN_WARM_CONCURRENCY,
  OpenWarmer,
  registerReading,
} from "../../apps/api/src/library/reading.js";
import { readSlices } from "../../apps/api/src/library/reading-slices.js";
import { PDF_SLICE_BYTES } from "../../packages/contracts/src/reading.js";
import { LibrarySync, VERIFY_REUSE_MS } from "../../apps/api/src/drive/sync.js";
import type {
  DriveClient,
  DriveFile,
} from "../../apps/api/src/drive/client.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { prepareReading } from "../../apps/worker/src/reading.js";
import { SOURCE_BLOCK_BYTES } from "../../packages/contracts/src/index.js";
import { createHarness } from "../fixtures/harness.js";

function library(size: number) {
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
    md5Checksum: "a",
    size: String(size),
  };
  const calls = { get: 0, fail: false };
  const client: DriveClient = {
    get: async (id) => {
      calls.get++;
      if (calls.fail) throw new Error("Drive unavailable");
      return { ...(id === "root" ? root : file) };
    },
    list: async () => ({ files: [file] }),
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
  return { file, calls, client };
}

it("reuses a book's Drive verification for five seconds, never after a read or a change", async () => {
  const h = await createHarness();
  const { file, calls, client } = library(100);
  let clock = Date.now();
  const sync = new LibrarySync(h.db, client, () => clock);
  try {
    await sync.syncLibrary("root", new AbortController().signal);
    calls.get = 0;
    // Book and folder, asked together; the folder is the book's parent.
    const first = await sync.verifyReading("book");
    expect(calls.get).toBe(2);
    expect(await sync.verifyReading("book")).toEqual(first);
    expect(calls.get).toBe(2);
    // Simultaneous range requests share one question to Drive.
    calls.get = 0;
    clock += VERIFY_REUSE_MS;
    await Promise.all([1, 2, 3].map(() => sync.verifyReading("book")));
    expect(calls.get).toBe(2);
    // After a read, the answer must be new.
    await sync.verifyReading("book", true);
    expect(calls.get).toBe(4);
    // A failure is never reused.
    calls.fail = true;
    await expect(sync.verifyReading("book", true)).rejects.toThrow();
    calls.fail = false;
    calls.get = 0;
    await sync.verifyReading("book");
    expect(calls.get).toBe(2);
    // Local state is read on every call: an unavailable book is refused at once.
    h.db.prepare("UPDATE reading_items SET available=0").run();
    calls.get = 0;
    await expect(sync.verifyReading("book")).rejects.toThrow();
    expect(calls.get).toBe(0);
    h.db.prepare("UPDATE reading_items SET available=1").run();
    // A scan that publishes another generation is not satisfied by the old answer.
    h.db.prepare("UPDATE reading_items SET generation=?").run("c".repeat(64));
    expect((await sync.verifyReading("book")).generation).toBe("c".repeat(64));
    expect(calls.get).toBe(2);
    // Content that changed in Drive is caught once the window has passed.
    file.md5Checksum = "b";
    clock += VERIFY_REUSE_MS;
    await expect(sync.verifyReading("book")).rejects.toThrow();
  } finally {
    await h.close();
  }
});

it("serves a book range with one Drive check per fetched block and none for a warm repeat", async () => {
  const h = await createHarness();
  const size = 2 * SOURCE_BLOCK_BYTES + 13;
  const bytes = Buffer.alloc(size, 7);
  const { calls, client } = library(size);
  const sync = new LibrarySync(h.db, client);
  const app = Fastify();
  let reads = 0;
  const reader = new DriveSourceReader(
    async () => "test-token",
    (id, fresh) => sync.verifyReading(id, fresh),
    async (_url, init) => {
      const range = new Headers(init?.headers).get("range")!;
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
      reads++;
      return new Response(bytes.subarray(Number(a), Number(b) + 1), {
        status: 206,
        headers: { "content-range": `bytes ${a}-${b}/${size}` },
      });
    },
  );
  const cache = new BlockCache(
    h.db,
    join(dirname(h.db.name), "reading-speed-cache"),
    { maxBytes: 64n * 1024n * 1024n, minFreeBytes: 0n, readAhead: 2 },
    (ref, a, b, signal) => reader.block(ref, a, b, signal),
  );
  await cache.init();
  registerReading(app, h.db, sync, cache, true);
  try {
    await sync.syncLibrary("root", new AbortController().signal);
    const generation = (
      h.db.prepare("SELECT generation FROM reading_items").get() as {
        generation: string;
      }
    ).generation;
    const url = `/api/reading/book/content?generation=${generation}`;
    calls.get = 0;
    const cold = await app.inject(url);
    expect(cold.statusCode).toBe(200);
    expect(cold.rawPayload.equals(bytes)).toBe(true);
    expect(reads).toBe(3);
    // The request's own check, then one fresh check after each block from
    // Drive. Each costs two lookups (book and folder). Before reuse, every
    // block also asked first, and the stream asked again: about twice this.
    expect(calls.get).toBeLessThanOrEqual(2 * (1 + 3));
    calls.get = 0;
    const warm = await app.inject({ url, headers: { range: "bytes=0-99" } });
    expect(warm.statusCode).toBe(206);
    expect(reads).toBe(3);
    expect(calls.get).toBe(0);
  } finally {
    await app.close();
    await h.close();
  }
});

it("warms several book blocks at once and stops them all on the first failure", async () => {
  const h = await createHarness();
  const blocks = 7;
  const size = blocks * SOURCE_BLOCK_BYTES;
  const generation = "d".repeat(64);
  h.db
    .prepare(
      "INSERT INTO reading_items(id,name,format,generation,size_bytes,metadata) VALUES('book','Book.cbz','cbz',?,?,'{}')",
    )
    .run(generation, String(size));
  const queue = new JobQueue(h.db);
  const ref = { fileId: "book", generation, sizeBytes: String(size) };
  const start = (key: string) => {
    queue.enqueue("reading", key, ref);
    return queue.claim("reading")!;
  };
  const store = h.db.prepare(
    "INSERT INTO cache_blocks(key,source_id,generation,block_index,size_bytes,state,last_used) VALUES(?,?,?,?,?,'ready',0)",
  );
  try {
    let running = 0,
      peak = 0;
    const order: number[] = [];
    await prepareReading(
      h.db,
      queue,
      start("reading:one"),
      ref,
      new AbortController().signal,
      async (index) => {
        order.push(index);
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        store.run(`k${index}`, "book", generation, index, SOURCE_BLOCK_BYTES);
        running--;
      },
      3,
    );
    expect(peak).toBe(3);
    // Header and directory first, then the rest in order, each exactly once.
    expect(order.slice(0, 2)).toEqual([0, blocks - 1]);
    expect([...order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: blocks }, (_, i) => i),
    );

    h.db.prepare("DELETE FROM cache_blocks").run();
    h.db.prepare("DELETE FROM jobs").run();
    const aborted: number[] = [];
    let started = 0;
    await expect(
      prepareReading(
        h.db,
        queue,
        start("reading:two"),
        ref,
        new AbortController().signal,
        (index, signal) =>
          new Promise<void>((resolve, reject) => {
            started++;
            if (index === blocks - 1)
              return void setTimeout(() => reject(new Error("Drive")), 5);
            signal.addEventListener("abort", () => {
              aborted.push(index);
              reject(signal.reason);
            });
            void resolve;
          }),
        3,
      ),
    ).rejects.toThrow("Drive");
    // The two blocks in flight beside the failure were cancelled, and no
    // more were started after it.
    expect(started).toBe(3);
    expect(aborted.sort()).toEqual([0, 1]);
  } finally {
    await h.close();
  }
});

it("warms an opened book's missing blocks four at a time, ends first, and once", async () => {
  const h = await createHarness();
  const blocks = 9;
  const ref = {
    fileId: "book",
    generation: "e".repeat(64),
    sizeBytes: String(blocks * SOURCE_BLOCK_BYTES - 5),
  };
  h.db
    .prepare(
      "INSERT INTO cache_blocks(key,source_id,generation,block_index,size_bytes,state,last_used) VALUES('k3','book',?,3,?,'ready',0)",
    )
    .run(ref.generation, SOURCE_BLOCK_BYTES);
  const order: number[] = [];
  let running = 0,
    peak = 0;
  const cache = {
    async *readSource(
      _source: unknown,
      start: bigint,
      end: bigint,
      signal: AbortSignal,
    ) {
      order.push(Number(start / BigInt(SOURCE_BLOCK_BYTES)));
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      signal.throwIfAborted();
      yield new Uint8Array(Number(end - start + 1n));
    },
  };
  try {
    const warmer = new OpenWarmer(h.db, cache);
    await Promise.all([warmer.start(ref), warmer.start(ref)]);
    expect(peak).toBe(OPEN_WARM_CONCURRENCY);
    // Header and directory first; the stored block is skipped; each once.
    expect(order.slice(0, 2)).toEqual([0, blocks - 1]);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
    // A failure stops the rest of the book.
    order.length = 0;
    const failing = {
      async *readSource() {
        order.push(0);
        throw new Error("cache_full");
      },
    };
    await new OpenWarmer(h.db, failing as never).start({
      ...ref,
      generation: "f".repeat(64),
    });
    expect(order.length).toBe(OPEN_WARM_CONCURRENCY);
  } finally {
    await h.close();
  }
});

it("downloads a book block as parallel parts and fails it if any part fails", async () => {
  const size = SOURCE_BLOCK_BYTES + 100;
  const bytes = Buffer.alloc(size).map((_, i) => i % 199);
  const ranges: string[] = [];
  let open = 0,
    peak = 0,
    fail = false;
  const reader = new DriveSourceReader(
    async () => "token",
    async () => ({ fileId: "book", generation: "g", sizeBytes: String(size) }),
    async (_url, init) => {
      const range = new Headers(init?.headers).get("range")!;
      ranges.push(range);
      peak = Math.max(peak, ++open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
      if (fail && a !== "0") return new Response(null, { status: 404 });
      return new Response(bytes.subarray(Number(a), Number(b) + 1), {
        status: 206,
        headers: { "content-range": `bytes ${a}-${b}/${size}` },
      });
    },
    0,
    BOOK_BLOCK_PARTS,
  );
  const source = { fileId: "book", generation: "g", sizeBytes: String(size) };
  const end = BigInt(SOURCE_BLOCK_BYTES - 1);
  const block = await reader.block(
    source,
    0n,
    end,
    new AbortController().signal,
  );
  expect(Buffer.from(block).equals(bytes.subarray(0, SOURCE_BLOCK_BYTES))).toBe(
    true,
  );
  expect(ranges).toHaveLength(BOOK_BLOCK_PARTS);
  expect(peak).toBe(BOOK_BLOCK_PARTS);
  // The 100-byte tail is too small to split.
  ranges.length = 0;
  await reader.block(
    source,
    BigInt(SOURCE_BLOCK_BYTES),
    BigInt(size - 1),
    new AbortController().signal,
  );
  expect(ranges).toEqual([`bytes=${SOURCE_BLOCK_BYTES}-${size - 1}`]);
  fail = true;
  await expect(
    reader.block(source, 0n, end, new AbortController().signal),
  ).rejects.toThrow();
});

it("reads the slices of different cache blocks side by side", async () => {
  const size = 3 * SOURCE_BLOCK_BYTES;
  let open = 0,
    peak = 0;
  const cache = {
    async *readSource(_s: unknown, start: bigint, end: bigint) {
      peak = Math.max(peak, ++open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      yield new Uint8Array(Number(end - start + 1n)).fill(
        Number(start / BigInt(SOURCE_BLOCK_BYTES)) + 1,
      );
    },
  };
  const per = SOURCE_BLOCK_BYTES / PDF_SLICE_BYTES;
  const ids = [0, 5, per, per + 1, 2 * per + 3];
  const data = await readSlices(
    cache as never,
    { fileId: "book", generation: "g", sizeBytes: String(size) },
    ids,
    new AbortController().signal,
  );
  expect(peak).toBe(3);
  expect(data.length).toBe(ids.length * PDF_SLICE_BYTES);
  // Each slice came from its own block, in request order.
  expect([...ids.keys()].map((k) => data[k * PDF_SLICE_BYTES])).toEqual([
    1, 1, 2, 2, 3,
  ]);
});
