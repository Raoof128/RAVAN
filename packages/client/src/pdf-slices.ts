import {
  MAX_PDF_SLICES,
  PDF_SLICE_BYTES,
} from "../../contracts/src/reading.js";

/** Slice requests in flight. With the four range requests, below the API's eight. */
export const PDF_SLICE_CONCURRENCY = 4;
type Slice = {
  id: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
};

/** Batch PDF.js's scattered requests with bounded concurrency. The PDF worker
 * retains delivered ranges; this queue only owns requests currently in flight. */
export class PdfSlices {
  private pending: Slice[] = [];
  /** Slices fetched before PDF.js asked for them, delivered once and dropped. */
  private early = new Map<number, Promise<Uint8Array>>();
  private active = 0;
  private scheduled = false;
  constructor(
    private readonly size: number,
    private readonly fetchBytes: (
      ids: number[],
      length: number,
    ) => Promise<Uint8Array>,
  ) {}
  private schedule() {
    if (
      this.scheduled ||
      !this.pending.length ||
      this.active >= PDF_SLICE_CONCURRENCY
    )
      return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      while (this.active < PDF_SLICE_CONCURRENCY && this.pending.length) {
        this.active++;
        void this.send(this.pending.splice(0, MAX_PDF_SLICES)).finally(() => {
          this.active--;
          this.schedule();
        });
      }
    }, 0);
  }
  private async send(slices: Slice[]) {
    try {
      const ids = [...new Set(slices.map((s) => s.id))].sort((a, b) => a - b);
      const lengths = ids.map((id) =>
        Math.min(PDF_SLICE_BYTES, this.size - id * PDF_SLICE_BYTES),
      );
      const data = await this.fetchBytes(
        ids,
        lengths.reduce((a, b) => a + b, 0),
      );
      const parts = new Map<number, Uint8Array>();
      let offset = 0;
      ids.forEach((id, i) => {
        parts.set(id, data.subarray(offset, offset + lengths[i]!));
        offset += lengths[i]!;
      });
      for (const s of slices) s.resolve(parts.get(s.id)!);
    } catch (error) {
      for (const s of slices) s.reject(error);
    }
  }
  private request(id: number) {
    return new Promise<Uint8Array>((resolve, reject) =>
      this.pending.push({ id, resolve, reject }),
    );
  }
  /** Fetch whole slices of `[begin, end)` now, for a read expected soon. */
  prefetch(begin: number, end: number) {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      begin >= end ||
      end > this.size ||
      begin % PDF_SLICE_BYTES !== 0
    )
      return;
    for (
      let pos = begin;
      pos < end && this.early.size < MAX_PDF_SLICES;
      pos += PDF_SLICE_BYTES
    ) {
      const id = pos / PDF_SLICE_BYTES;
      if (this.early.has(id)) continue;
      const part = this.request(id);
      part.catch(() => this.early.delete(id));
      this.early.set(id, part);
    }
    this.schedule();
  }
  async read(begin: number, end: number) {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      begin >= end ||
      end > this.size ||
      begin % PDF_SLICE_BYTES !== 0
    )
      throw new Error("Invalid PDF range");
    const parts: Promise<Uint8Array>[] = [];
    for (let pos = begin; pos < end; pos += PDF_SLICE_BYTES) {
      const id = pos / PDF_SLICE_BYTES;
      const early = this.early.get(id);
      this.early.delete(id);
      parts.push(early ?? this.request(id));
    }
    this.schedule();
    const result = new Uint8Array(end - begin);
    let offset = 0;
    for (const part of await Promise.all(parts)) {
      const count = Math.min(result.length - offset, part.length);
      result.set(part.subarray(0, count), offset);
      offset += count;
    }
    return result;
  }
}
