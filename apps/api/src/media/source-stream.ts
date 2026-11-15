import { setTimeout as delay } from "node:timers/promises";
import type { SourceRef } from "../../../../packages/contracts/src/index.js";
import { driveId, usageLimited } from "../drive/client.js";
/** A Drive read that failed for a reason another attempt cannot change. */
class PermanentSourceError extends Error {}
export class DriveSourceReader {
  constructor(
    private token: () => Promise<string>,
    private verify: (id: string, fresh?: boolean) => Promise<SourceRef>,
    private fetcher: typeof fetch = fetch,
    private retryDelayMs = 250,
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
    const bytes = await this.read(source, start, end, signal);
    // This answer must be newer than the bytes just read; an earlier one cannot
    // vouch that they belong to the catalogued generation.
    const after = await this.verify(source.fileId, true);
    if (
      after.generation !== source.generation ||
      after.sizeBytes !== source.sizeBytes
    )
      throw new Error("Source changed");
    signal.throwIfAborted();
    return bytes;
  }
  /**
   * One dropped connection or 5xx used to end a whole response, and with it an
   * hours-long conversion reading through it. Retry what can plausibly recover.
   */
  private async read(
    source: SourceRef,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(source, start, end, signal);
      } catch (error) {
        if (
          signal.aborted ||
          attempt >= 2 ||
          error instanceof PermanentSourceError
        )
          throw error;
        await delay(
          this.retryDelayMs * 2 ** attempt + Math.random() * this.retryDelayMs,
          undefined,
          { signal },
        );
      }
    }
  }
  private async attempt(
    source: SourceRef,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    // A malformed id or a revoked Drive grant will not improve on a second try.
    let id: string, token: string;
    try {
      id = driveId.parse(source.fileId);
      token = await this.token();
    } catch {
      throw new PermanentSourceError("Drive access unavailable");
    }
    const response = await this.fetcher(
      `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
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
      // A usage limit arrives as 403 too; it passes, so it is worth asking again.
      const limited = await usageLimited(response);
      if (response.status !== 403) await response.body?.cancel();
      const message = "Upstream range mismatch";
      throw limited || response.status === 429 || response.status >= 500
        ? new Error(message)
        : new PermanentSourceError(message);
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
        if (BigInt(size) > expected)
          throw new PermanentSourceError("Source length mismatch");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    // A short body is a connection that closed early, which a retry can recover.
    if (BigInt(size) !== expected) throw new Error("Source length mismatch");
    return Buffer.concat(chunks);
  }
}
