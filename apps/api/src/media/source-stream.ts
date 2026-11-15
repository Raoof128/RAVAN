import type { SourceRef } from "../../../../packages/contracts/src/index.js";
import { driveId } from "../drive/client.js";
export class DriveSourceReader {
  constructor(
    private token: () => Promise<string>,
    private verify: (id: string) => Promise<SourceRef>,
    private fetcher: typeof fetch = fetch,
  ) {}
  async block(
    source: SourceRef,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (end < start || end - start >= 4n * 1024n * 1024n)
      throw new Error("Invalid block size");
    const before = await this.verify(source.fileId);
    if (before.generation !== source.generation)
      throw new Error("Source changed");
    const response = await this.fetcher(
      `https://www.googleapis.com/drive/v3/files/${driveId.parse(source.fileId)}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Range: `bytes=${start}-${end}`,
          "Accept-Encoding": "identity",
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      },
    );
    const expected = end - start + 1n;
    if (
      response.status !== 206 ||
      response.headers.get("content-range") !==
        `bytes ${start}-${end}/${source.sizeBytes}`
    ) {
      await response.body?.cancel();
      throw new Error("Upstream range mismatch");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty source");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (BigInt(size) > expected) throw new Error("Source length mismatch");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    if (BigInt(size) !== expected) throw new Error("Source length mismatch");
    const after = await this.verify(source.fileId);
    if (
      after.generation !== source.generation ||
      after.sizeBytes !== source.sizeBytes
    )
      throw new Error("Source changed");
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  }
}
