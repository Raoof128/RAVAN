import type { ReadingRanges } from "../../../../packages/client/src/reading-ranges.js";
import { BlobReader, Reader, ZipReader, type FileEntry } from "@zip.js/zip.js";

const ENTRY_LIMIT = 32 * 1024 * 1024;
/** Reject ambiguity even though nothing is ever extracted onto the filesystem. */
export function safeArchivePath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 1024 &&
    !/[\\\u0000-\u001f]/.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    !/^[a-z][a-z\d+.-]*:/i.test(path)
  );
}
class RangeArchiveReader extends Reader<ReadingRanges> {
  constructor(private readonly ranges: ReadingRanges) {
    super(ranges);
    this.size = ranges.size;
  }
  readUint8Array(offset: number, length: number) {
    return this.ranges.read(offset, Math.min(length, this.size - offset));
  }
}
export async function openArchive(
  blob: Blob | ReadingRanges,
  signal: AbortSignal,
) {
  const zip = new ZipReader(
    blob instanceof Blob ? new BlobReader(blob) : new RangeArchiveReader(blob),
    {
      useWebWorkers: false,
      useCompressionStream: true,
    },
  );
  const entries = new Map<string, FileEntry>();
  let total = 0,
    count = 0;
  try {
    for await (const entry of zip.getEntriesGenerator()) {
      signal.throwIfAborted();
      if (++count > 5000)
        throw new Error("This archive has too many files (maximum 5,000).");
      if (!safeArchivePath(entry.filename))
        throw new Error("This archive contains an unsafe file path.");
      if (entry.directory) continue;
      total += entry.uncompressedSize;
      if (
        entry.encrypted ||
        entry.uncompressedSize > ENTRY_LIMIT ||
        total > 512 * 1024 * 1024
      )
        throw new Error(
          "This archive is encrypted or exceeds the reader’s extraction limits.",
        );
      if (entries.has(entry.filename))
        throw new Error("This archive contains duplicate file paths.");
      entries.set(entry.filename, entry);
    }
  } catch (error) {
    await zip.close();
    throw error;
  }
  return {
    entries,
    async read(
      path: string,
      limit = ENTRY_LIMIT,
      pageSignal?: AbortSignal,
    ): Promise<Uint8Array<ArrayBuffer>> {
      const readingSignal = pageSignal
        ? AbortSignal.any([signal, pageSignal])
        : signal;
      readingSignal.throwIfAborted();
      const entry = entries.get(path);
      if (!entry || entry.uncompressedSize > limit)
        throw new Error("A book resource is missing or too large.");
      // Ask for the whole entry at once instead of one block per inflate step.
      // The local header (30 bytes, a name and an extra field) comes first;
      // anything past this hint is still read, just without read-ahead.
      if (!(blob instanceof Blob))
        blob.prefetch(entry.offset, entry.compressedSize + 65536);
      let size = 0;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      // Declared ZIP sizes are untrusted. Stop the actual output stream too.
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            readingSignal.throwIfAborted();
            size += chunk.byteLength;
            if (size > limit || size > entry.uncompressedSize)
              throw new Error("Archive extraction limit exceeded.");
            chunks.push(new Uint8Array(chunk));
          },
        }),
        { signal: readingSignal, checkSignature: true },
      );
      if (size !== entry.uncompressedSize)
        throw new Error("Incomplete archive entry.");
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return data;
    },
    close: () => zip.close(),
  };
}
export type ReadingArchive = Awaited<ReturnType<typeof openArchive>>;
/** Resolve EPUB relative references inside the ZIP, never as network URLs. */
export function resolveResource(
  base: string,
  reference: string,
): string | undefined {
  if (!reference || /^[a-z][a-z\d+.-]*:|^[/\\]/i.test(reference)) return;
  try {
    const decoded = decodeURIComponent(reference.split(/[?#]/)[0]!);
    if (/[\\\u0000-\u001f]/.test(decoded) || decoded.startsWith("/")) return;
    const parts = base.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return;
        parts.pop();
      } else parts.push(part);
    }
    const path = parts.join("/");
    return safeArchivePath(path) ? path : undefined;
  } catch {
    return;
  }
}
