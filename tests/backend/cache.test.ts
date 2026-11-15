import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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
