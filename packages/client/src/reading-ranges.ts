import { PdfSlices } from "./pdf-slices.js";
import { MAX_PDF_READING_BYTES } from "../../contracts/src/reading.js";

export const RANGE_BYTES = 1024 * 1024;

/** Blocks kept per open book. Evicted ranges can be read again from the origin cache. */
export const RANGE_WINDOW = 12;
/** Requests in flight at once. The API admits eight reader requests in total. */
export const RANGE_CONCURRENCY = 4;
/** Blocks fetched ahead of a sequential read inside a hinted extent. */
const RANGE_AHEAD = 4;

/**
 * A small, per-open window over a book's bytes. A read that spans several
 * blocks fetches them together, and `prefetch` marks an extent (an archive
 * entry about to be inflated) so the blocks after the one being read are
 * already on their way. Waiting for each 1 MiB block in turn made a manga page
 * cost one round trip per megabyte.
 */
export class ReadingRanges {
  private readonly blocks = new Map<number, Promise<Uint8Array>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private extent = { start: 0, end: 0 };
  constructor(
    readonly size: number,
    private readonly url: string,
    private readonly signal: AbortSignal,
  ) {
    // Read in bounded pieces, so the largest book that opens at all: a PDF.
    // An EPUB or CBZ is held to its own limit where it is opened whole.
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PDF_READING_BYTES)
      throw new Error("Invalid book size");
    this.pdfSlices = new PdfSlices(size, (ids, length) =>
      this.fetchBytes(url + "&slices=" + ids.join(","), length),
    );
  }
  readonly pdfSlices: PdfSlices;
  private async slot() {
    if (this.active < RANGE_CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
  private async fetchBlock(start: number) {
    await this.slot();
    try {
      this.signal.throwIfAborted();
      const end = Math.min(this.size, start + RANGE_BYTES) - 1;
      return await this.fetchBytes(this.url, end - start + 1, { start, end });
    } finally {
      this.release();
    }
  }
  private block(start: number): Promise<Uint8Array> {
    let block = this.blocks.get(start);
    if (block) {
      // Most recently used goes last, so eviction drops the oldest.
      this.blocks.delete(start);
    } else {
      block = this.fetchBlock(start);
      const pending = block;
      pending.catch(() => {
        if (this.blocks.get(start) === pending) this.blocks.delete(start);
      });
    }
    this.blocks.set(start, block);
    while (this.blocks.size > RANGE_WINDOW)
      this.blocks.delete(this.blocks.keys().next().value!);
    return block;
  }
  /** Start fetching the blocks of `[offset, offset + length)` ahead of reads. */
  prefetch(offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) return;
    const start = Math.max(0, offset);
    const end = Math.min(this.size, start + Math.max(0, length));
    if (start >= end) return;
    this.extent = { start, end };
    this.ahead(start);
  }
  private ahead(position: number) {
    const { start, end } = this.extent;
    if (position < start || position >= end) return;
    let block = position - (position % RANGE_BYTES);
    for (let n = 0; n < RANGE_AHEAD && block < end; n++, block += RANGE_BYTES)
      if (!this.blocks.has(block)) void this.block(block).catch(() => {});
  }
  private async fetchBytes(
    url: string,
    length: number,
    range?: { start: number; end: number },
  ) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(90000)]),
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
    });
    if (
      response.status !== (range ? 206 : 200) ||
      (range &&
        response.headers.get("Content-Range") !==
          `bytes ${range.start}-${range.end}/${this.size}`)
    ) {
      await response.body?.cancel();
      throw new Error("Book range unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty book range");
    const data = new Uint8Array(length);
    let offset = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        data.set(chunk.value, offset);
        offset += chunk.value.length;
      }
      if (offset !== data.length) throw new Error("Incomplete book range");
      return data;
    } finally {
      await reader.cancel();
    }
  }
  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    )
      throw new Error("Invalid book range");
    const bytes = new Uint8Array(length);
    if (!length) return bytes;
    const first = offset - (offset % RANGE_BYTES);
    const pending: Array<[number, Promise<Uint8Array>]> = [];
    for (let start = first; start < offset + length; start += RANGE_BYTES)
      pending.push([start, this.block(start)]);
    this.ahead(offset + length);
    for (const [start, block] of pending) {
      const data = await block;
      const from = Math.max(offset, start) - start;
      const to = Math.min(offset + length, start + data.length) - start;
      bytes.set(data.subarray(from, to), start + from - offset);
    }
    return bytes;
  }
}
