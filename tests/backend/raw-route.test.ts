import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sendRaw } from "../../apps/api/src/media/raw-route.js";
import { BlockCache } from "../../apps/api/src/media/cache.js";
import { openDatabase } from "../../packages/db/src/open.js";

const clean: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of clean.splice(0).reverse()) await step();
});

// The worker reads books in 64 KiB pieces (PDF.js's chunk size). A response
// whose last chunk filled the body's 64 KiB buffer was destroyed before it was
// written, so it never finished: on production every PDF cover read hung.
it("finishes every range response, including one of exactly 64 KiB", async () => {
  const size = 9 * 1024 * 1024 + 12345;
  const file = Buffer.alloc(size);
  for (let i = 0; i < size; i++) file[i] = i % 251;
  const dir = await mkdtemp(join(tmpdir(), "mov-raw-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  clean.push(() => db.close());
  const cache = new BlockCache(
    db,
    join(dir, "cache"),
    { maxBytes: 1n << 30n, minFreeBytes: 0n, readAhead: 2 },
    async (_ref, start, end) =>
      new Uint8Array(file.subarray(Number(start), Number(end) + 1)),
  );
  await cache.init();
  const app = Fastify({ forceCloseConnections: true });
  const ref = {
    fileId: "book",
    generation: "a".repeat(64),
    sizeBytes: String(size),
  };
  app.get("/raw", (request, reply) =>
    sendRaw(
      request,
      reply,
      ref,
      cache,
      async () => {},
      "application/octet-stream",
    ),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  clean.push(() => app.close());
  const tail = size - 16059;
  const ranges: Array<[number, number]> = [
    [tail - 65536, tail], // a fresh block
    [tail, size],
    [tail - 65536, tail], // the same, now cached
    [0, 65536],
    [0, 65536],
    [0, 65535],
    [0, 65537],
    [4 * 1024 * 1024 - 65536, 4 * 1024 * 1024 + 65536], // across blocks
    [0, 300000],
  ];
  for (const [start, end] of ranges) {
    const response = await fetch(`${address}/raw`, {
      headers: { range: `bytes=${start}-${end - 1}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      file.subarray(start, end),
    );
  }
});
