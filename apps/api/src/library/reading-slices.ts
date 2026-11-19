import {
  MAX_PDF_SLICES,
  PDF_SLICE_BYTES,
} from "../../../../packages/contracts/src/reading.js";
import {
  SOURCE_BLOCK_BYTES,
  type SourceRef,
} from "../../../../packages/contracts/src/index.js";
import type { BlockCache } from "../media/cache.js";

export function parseReadingSlices(value: string, size: number) {
  if (
    typeof value !== "string" ||
    value.length > MAX_PDF_SLICES * 6 ||
    !/^\d{1,4}(,\d{1,4})*$/.test(value)
  )
    return;
  const ids = value.split(",").map(Number);
  if (
    ids.length > MAX_PDF_SLICES ||
    ids.some(
      (id, i) => id * PDF_SLICE_BYTES >= size || (i > 0 && id <= ids[i - 1]!),
    )
  )
    return;
  return ids;
}

/** Spans of a slice request read side by side. */
const SLICE_SPAN_CONCURRENCY = 4;

export async function readSlices(
  cache: Pick<BlockCache, "readSource">,
  source: SourceRef,
  ids: number[],
  signal: AbortSignal,
) {
  const size = Number(source.sizeBytes);
  const length = (id: number) =>
    Math.min(PDF_SLICE_BYTES, size - id * PDF_SLICE_BYTES);
  const offsets: number[] = [];
  let total = 0;
  for (const id of ids) {
    offsets.push(total);
    total += length(id);
  }
  const result = Buffer.alloc(total);
  // A span is the slices of one cache block, read once even if dozens of
  // dictionaries are interleaved with full-page images in that block. Spans
  // in different blocks are read side by side: a cold block costs a whole
  // Drive download, and one after another they added up.
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < ids.length;) {
    const boundary =
      (Math.floor((ids[i]! * PDF_SLICE_BYTES) / SOURCE_BLOCK_BYTES) + 1) *
      SOURCE_BLOCK_BYTES;
    let j = i + 1;
    while (j < ids.length && ids[j]! * PDF_SLICE_BYTES < boundary) j++;
    spans.push([i, j]);
    i = j;
  }
  let next = 0;
  const lane = async () => {
    while (next < spans.length) {
      const [i, j] = spans[next++]!;
      const first = ids[i]! * PDF_SLICE_BYTES;
      const end = Math.min((ids[j - 1]! + 1) * PDF_SLICE_BYTES, size);
      const parts: Uint8Array[] = [];
      for await (const part of cache.readSource(
        { ...source, reading: "foreground" },
        BigInt(first),
        BigInt(end - 1),
        signal,
      ))
        parts.push(part);
      const span = Buffer.concat(parts);
      if (span.length !== end - first) throw new Error("Incomplete book block");
      for (let k = i; k < j; k++) {
        const offset = ids[k]! * PDF_SLICE_BYTES - first;
        result.set(
          span.subarray(offset, offset + length(ids[k]!)),
          offsets[k]!,
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SLICE_SPAN_CONCURRENCY, spans.length) },
      lane,
    ),
  );
  return result;
}
