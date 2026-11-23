import { afterEach, expect, it, vi } from "vitest";
import {
  RANGE_BYTES,
  RANGE_CONCURRENCY,
  ReadingRanges,
} from "../../packages/client/src/reading-ranges.js";
import {
  MAX_PDF_SLICES,
  PDF_SLICE_BYTES,
} from "../../packages/contracts/src/reading.js";
import { PDF_SLICE_CONCURRENCY } from "../../packages/client/src/pdf-slices.js";
import { PageCache } from "../../apps/web/src/reading/pages.js";
import type { BookPage, OpenBook } from "../../apps/web/src/reading/book.js";

afterEach(() => vi.unstubAllGlobals());

/** A fake byte route that holds every response until `release` is called. */
function server(size: number) {
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  const log = {
    ranges: [] as string[],
    slices: [] as string[],
    open: 0,
    peak: 0,
  };
  const held: Array<() => void> = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    log.open++;
    log.peak = Math.max(log.peak, log.open);
    await new Promise<void>((resolve) => held.push(resolve));
    log.open--;
    const slices = new URL(input, "http://x").searchParams.get("slices");
    if (slices) {
      log.slices.push(slices);
      const parts = slices
        .split(",")
        .map(Number)
        .map((id) =>
          bytes.subarray(id * PDF_SLICE_BYTES, (id + 1) * PDF_SLICE_BYTES),
        );
      return new Response(new Blob(parts), { status: 200 });
    }
    const range = new Headers(init.headers).get("range")!;
    log.ranges.push(range);
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
    return new Response(bytes.slice(Number(a), Number(b) + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${a}-${b}/${size}` },
    });
  });
  const flush = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      held.splice(0).forEach((go) => go());
    }
  };
  return { bytes, log, held, flush };
}

it("fetches the blocks of a long read together, at most four at a time", async () => {
  const size = 9 * RANGE_BYTES + 5;
  const { bytes, log, held, flush } = server(size);
  const ranges = new ReadingRanges(
    size,
    "/book?generation=g",
    new AbortController().signal,
  );
  const read = ranges.read(10, 7 * RANGE_BYTES);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Before any answer arrives, several blocks are already requested.
  expect(held.length).toBe(RANGE_CONCURRENCY);
  await flush();
  const data = await read;
  expect(
    Buffer.from(data).equals(
      Buffer.from(bytes.subarray(10, 10 + 7 * RANGE_BYTES)),
    ),
  ).toBe(true);
  expect(log.peak).toBe(RANGE_CONCURRENCY);
  expect(new Set(log.ranges).size).toBe(log.ranges.length);
  // A repeat inside the window is answered without the network.
  const before = log.ranges.length;
  expect((await ranges.read(RANGE_BYTES, 3))[0]).toBe(bytes[RANGE_BYTES]);
  expect(log.ranges.length).toBe(before);
});

it("reads ahead inside a hinted archive entry", async () => {
  const size = 8 * RANGE_BYTES;
  const { log, flush } = server(size);
  const ranges = new ReadingRanges(
    size,
    "/book?generation=g",
    new AbortController().signal,
  );
  ranges.prefetch(RANGE_BYTES + 100, 5 * RANGE_BYTES);
  await flush();
  // The entry's first blocks are fetched before anything reads them.
  expect(log.ranges).toEqual(
    [1, 2, 3, 4].map(
      (i) => `bytes=${i * RANGE_BYTES}-${(i + 1) * RANGE_BYTES - 1}`,
    ),
  );
  const count = log.ranges.length;
  const read = ranges.read(RANGE_BYTES + 100, 2 * RANGE_BYTES);
  await flush();
  await read;
  // The reader moved on, so the rest of the entry (blocks 5 and 6, which
  // holds its last 100 bytes) is now on its way, and nothing past it.
  expect(log.ranges.slice(count)).toEqual(
    [5, 6].map((i) => `bytes=${i * RANGE_BYTES}-${(i + 1) * RANGE_BYTES - 1}`),
  );
});

it("delivers a prefetched PDF tail without asking again", async () => {
  const size = 4 * RANGE_BYTES;
  const { bytes, log, flush } = server(size);
  const ranges = new ReadingRanges(
    size,
    "/book?generation=g",
    new AbortController().signal,
  );
  const tail = size - 4 * PDF_SLICE_BYTES;
  ranges.pdfSlices.prefetch(tail, size);
  await flush();
  expect(log.slices).toHaveLength(1);
  const read = ranges.pdfSlices.read(tail, size);
  await flush();
  const data = await read;
  expect(log.slices).toHaveLength(1);
  expect(Buffer.from(data).equals(Buffer.from(bytes.subarray(tail)))).toBe(
    true,
  );
  // Delivered once: a second read of the same range asks the server.
  const again = ranges.pdfSlices.read(tail, tail + PDF_SLICE_BYTES);
  await flush();
  await again;
  expect(log.slices).toHaveLength(2);
});

it("keeps neighbouring pages loaded, releases what it drops and retries a failure", async () => {
  const loads: number[] = [];
  const released: number[] = [];
  const aborted: number[] = [];
  let failNext = true;
  const book: OpenBook = {
    format: "cbz",
    sections: Array.from({ length: 10 }, (_, i) => `Page ${i + 1}`),
    rtl: true,
    close: async () => {},
    page: (index, signal) => {
      loads.push(index);
      if (index === 9 && failNext) {
        failNext = false;
        return Promise.reject(new Error("broken"));
      }
      if (index === 8)
        return new Promise<BookPage>((_resolve, reject) =>
          signal?.addEventListener("abort", () => {
            aborted.push(index);
            reject(new Error("aborted"));
          }),
        );
      return Promise.resolve({
        html: `<p>${index}</p>`,
        release: () => released.push(index),
      });
    },
  };
  const pages = new PageCache(book);
  const first = await pages.get(3);
  pages.prefetch(4);
  pages.prefetch(10);
  pages.prefetch(-1);
  await Promise.resolve();
  // A turn to a prefetched page reuses it.
  expect(await pages.get(4)).not.toBe(first);
  expect(await pages.get(3)).toBe(first);
  expect(loads).toEqual([3, 4]);
  void pages.get(8);
  pages.keep([4, 5]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(released).toEqual([3]);
  expect(aborted).toEqual([8]);
  await expect(pages.get(9)).rejects.toThrow("broken");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await pages.get(9)).html).toBe("<p>9</p>");
  pages.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(released.sort()).toEqual([3, 4, 9]);
});

it("keeps four PDF slice batches in flight", async () => {
  const size = 8 * RANGE_BYTES;
  const { bytes, log, held } = server(size);
  const ranges = new ReadingRanges(
    size,
    "/book?generation=g",
    new AbortController().signal,
  );
  const length = 6 * MAX_PDF_SLICES * PDF_SLICE_BYTES;
  const read = ranges.pdfSlices.read(0, length);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(held.length).toBe(PDF_SLICE_CONCURRENCY);
  // Later batches appear only after the client consumes the first four bodies.
  // Release each new request until the mock has actually delivered all six.
  await expect
    .poll(
      () => {
        held.splice(0).forEach((release) => release());
        return log.slices.length;
      },
      { interval: 10, timeout: 10000 },
    )
    .toBe(6);
  expect(
    Buffer.from(await read).equals(Buffer.from(bytes.subarray(0, length))),
  ).toBe(true);
});
