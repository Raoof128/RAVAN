import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { BlockCache } from "../../apps/api/src/media/cache.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(limit = 8) {
  const dir = await mkdtemp(join(tmpdir(), "mov-cache-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let reads = 0;
  let fail = false;
  const path = join(dir, "cache");
  const cache = new BlockCache(
    db,
    path,
    { maxBytes: BigInt(limit), minFreeBytes: 0n, blockSize: 4 },
    async (_ref, start, end) => {
      reads++;
      if (fail) throw new Error("failed");
      return Buffer.from("0123456789").subarray(Number(start), Number(end) + 1);
    },
  );
  await cache.init();
  return {
    cache,
    path,
    reads: () => reads,
    fail: () => {
      fail = true;
    },
  };
}
const ref = { fileId: "one", generation: "v1", sizeBytes: "10" };
async function collect(cache: BlockCache) {
  const chunks = [];
  for await (const chunk of cache.readSource(
    ref,
    0n,
    9n,
    new AbortController().signal,
  ))
    chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
it("streams a source larger than the cache with exact bytes and bounded disk use", async () => {
  const { cache, path } = await setup();
  expect(await collect(cache)).toBe("0123456789");
  expect(
    (await readdir(path)).filter((n) => n.endsWith(".block")).length,
  ).toBeLessThanOrEqual(2);
});
it("coalesces concurrent reads without publishing incomplete blocks", async () => {
  const { cache, reads } = await setup(16);
  expect(await Promise.all([collect(cache), collect(cache)])).toEqual([
    "0123456789",
    "0123456789",
  ]);
  expect(reads()).toBe(3);
});
it("refuses a block beyond its storage budget and cleans up failed reads", async () => {
  const { cache } = await setup(2);
  await expect(collect(cache)).rejects.toThrow(/budget/);
  const second = await setup();
  second.fail();
  await expect(collect(second.cache)).rejects.toThrow("failed");
  expect(await readdir(second.path)).toEqual([]);
});
it("does not prefetch the whole source for a slow reader", async () => {
  const { cache, reads } = await setup();
  const iterator = cache
    .readSource(ref, 0n, 9n, new AbortController().signal)
    [Symbol.asyncIterator]();
  expect(Buffer.from((await iterator.next()).value!).toString()).toBe("0123");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads()).toBe(1);
  await iterator.return?.();
});
it("does not fail a new reader with a fetch that an earlier reader cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-cache-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let calls = 0;
  const cache = new BlockCache(
    db,
    join(dir, "cache"),
    { maxBytes: 64n, minFreeBytes: 0n, blockSize: 4 },
    async (_ref, start, end, signal) => {
      // The first fetch ends only once cancelled, and like a real aborted request
      // it takes a moment to unwind.
      if (++calls === 1)
        await new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => setTimeout(() => reject(new Error("aborted")), 30),
            { once: true },
          ),
        );
      return Buffer.from("0123456789").subarray(Number(start), Number(end) + 1);
    },
  );
  await cache.init();
  // A seek: the player cancels its range request and immediately asks for the same block.
  const seeking = new AbortController();
  const abandoned = cache
    .readSource(ref, 0n, 3n, seeking.signal)
    [Symbol.asyncIterator]()
    .next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  seeking.abort();
  await expect(abandoned).rejects.toThrow();
  const next = cache
    .readSource(ref, 0n, 3n, new AbortController().signal)
    [Symbol.asyncIterator]()
    .next();
  expect(Buffer.from((await next).value!).toString()).toBe("0123");
});
it("refetches a cached block whose file was truncated instead of failing forever", async () => {
  const { cache, path, reads } = await setup(16);
  expect(await collect(cache)).toBe("0123456789");
  const before = reads();
  const [damaged] = (await readdir(path)).filter((n) => n.endsWith(".block"));
  await writeFile(join(path, damaged!), "");
  expect(await collect(cache)).toBe("0123456789");
  expect(reads()).toBe(before + 1);
  expect(await collect(cache)).toBe("0123456789");
  expect(reads()).toBe(before + 1);
});

async function readAheadSetup(readAhead: number, limit = 64, delayMs = 20) {
  const dir = await mkdtemp(join(tmpdir(), "mov-cache-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const started: number[] = [];
  let active = 0,
    peak = 0,
    cancelled = 0;
  const cache = new BlockCache(
    db,
    join(dir, "cache"),
    { maxBytes: BigInt(limit), minFreeBytes: 0n, blockSize: 4, readAhead },
    async (_ref, start, end, signal) => {
      started.push(Number(start) / 4);
      peak = Math.max(peak, ++active);
      try {
        // Every block costs a network round trip.
        await new Promise<void>((resolve, reject) => {
          let pending = true;
          const timer = setTimeout(() => {
            pending = false;
            resolve();
          }, delayMs);
          signal.addEventListener(
            "abort",
            () => {
              if (!pending) return;
              clearTimeout(timer);
              cancelled++;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      } finally {
        active--;
      }
      return Buffer.from("0123456789abcdefghijklmnopqrstuv").subarray(
        Number(start),
        Number(end) + 1,
      );
    },
  );
  await cache.init();
  return {
    cache,
    started,
    peak: () => peak,
    cancelled: () => cancelled,
  };
}
const long = { fileId: "long", generation: "v1", sizeBytes: "32" };
async function drain(cache: BlockCache, from = 0n, to = 31n) {
  const chunks = [];
  for await (const chunk of cache.readSource(
    long,
    from,
    to,
    new AbortController().signal,
  ))
    chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

it("fetches ahead of the reader in parallel and still delivers exact bytes in order", async () => {
  const sequential = await readAheadSetup(0);
  let began = Date.now();
  expect(await drain(sequential.cache)).toBe(
    "0123456789abcdefghijklmnopqrstuv",
  );
  const oneAtATime = Date.now() - began;
  expect(sequential.peak()).toBe(1);

  const ahead = await readAheadSetup(2);
  began = Date.now();
  expect(await drain(ahead.cache)).toBe("0123456789abcdefghijklmnopqrstuv");
  const withReadAhead = Date.now() - began;
  expect(await drain(ahead.cache, 5n, 22n)).toBe("56789abcdefghijklm");
  expect(ahead.peak()).toBe(3);
  // Eight 20 ms blocks: about 160 ms one at a time, about 60 ms three at a time.
  expect(withReadAhead).toBeLessThan(oneAtATime * 0.9);
});

it("never runs further ahead than its window and stops when the reader leaves", async () => {
  const { cache, started, cancelled } = await readAheadSetup(2);
  const controller = new AbortController();
  const iterator = cache
    .readSource(long, 0n, 31n, controller.signal)
    [Symbol.asyncIterator]();
  expect(Buffer.from((await iterator.next()).value!).toString()).toBe("0123");
  // A slow reader: nothing beyond the two blocks after the one delivered.
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(started).toEqual([0, 1, 2]);
  expect(Buffer.from((await iterator.next()).value!).toString()).toBe("4567");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(started).toEqual([0, 1, 2, 3]);
  // Leaving cancels the fetch still in flight for a block nobody will read.
  await iterator.return?.();
  expect(cancelled()).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(started).toEqual([0, 1, 2, 3]);
});

it("an early fetch that finds no cache room does not fail the stream", async () => {
  // Room for two blocks only, while the window wants three at once.
  const { cache } = await readAheadSetup(2, 8, 5);
  expect(await drain(cache)).toBe("0123456789abcdefghijklmnopqrstuv");
});

it("keeps an open book readable when storage cannot admit background work", async () => {
  const { cache, reads } = await setup(1);
  const signal = new AbortController().signal;
  const values: Uint8Array[] = [];
  for await (const data of cache.readSource(
    { ...ref, reading: "foreground" },
    1n,
    3n,
    signal,
  ))
    values.push(data);
  expect(Buffer.concat(values).toString()).toBe("123");
  const background = cache
    .readSource({ ...ref, reading: "background" }, 1n, 3n, signal)
    [Symbol.asyncIterator]();
  await expect(background.next()).rejects.toThrow("Storage budget exhausted");
  expect(reads()).toBe(1);
});
