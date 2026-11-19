import { setTimeout as delay } from "node:timers/promises";
import {
  SOURCE_BLOCK_BYTES,
  type SourceRef,
} from "../../../../packages/contracts/src/index.js";
import { driveId, usageLimited } from "../drive/client.js";
/** A Drive read that failed for a reason another attempt cannot change. */
class PermanentSourceError extends Error {}
/** Drive asked us to slow down (429, or a 403 usage limit). */
class RateLimitedSource extends Error {}
/**
 * Google's backoff for rate limits: min(2^n s + up to 1 s, 32 s), several
 * times ("Resolve time-based quota errors", Drive API usage limits). Other
 * failures keep the short retry, so a dropped connection mid-film recovers fast.
 */
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_MAX_MS = 32000;
type Priority = 0 | 1 | 2;
/** The reader's own requests first, then an opened book's warming, then the worker. */
function priority(source: SourceRef): Priority {
  const reading = (source as { reading?: string }).reading;
  return reading === "background" ? 2 : reading === "open" ? 1 : 0;
}
export class DriveSourceReader {
  constructor(
    private token: () => Promise<string>,
    private verify: (id: string, fresh?: boolean) => Promise<SourceRef>,
    private fetcher: typeof fetch = fetch,
    private retryDelayMs = 250,
    /**
     * Requests one block is split into. Drive was seen to give each download
     * connection about 1 MiB/s from the production host, so a 4 MiB block in
     * one request took about four seconds; parts arrive side by side.
     */
    private parts = 1,
    /**
     * Downloads in flight at once. Each costs 200 Drive quota units against
     * 325,000 per user per minute; at about a second each, 24 stay under it.
     */
    private maxInFlight = Infinity,
    private rateLimitDelayMs = 1000,
  ) {}
  private inFlight = 0;
  private waiting: Array<{ priority: Priority; start: () => void }> = [];
  private coolUntil = 0;
  private async slot(source: SourceRef, signal: AbortSignal) {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return;
    }
    const entry = { priority: priority(source), start: () => {} };
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((w) => w !== entry);
        reject(signal.reason ?? new Error("Cancelled"));
      };
      entry.start = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      // Stable by arrival within a priority.
      const at = this.waiting.findIndex((w) => w.priority > entry.priority);
      if (at < 0) this.waiting.push(entry);
      else this.waiting.splice(at, 0, entry);
    });
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next.start();
    else this.inFlight--;
  }
  async block(
    source: SourceRef,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (end < start || end - start >= BigInt(SOURCE_BLOCK_BYTES))
      throw new Error("Invalid block size");
    const before = await this.verify(source.fileId);
    if (before.generation !== source.generation)
      throw new Error("Source changed");
    const bytes = await this.readParts(source, start, end, signal);
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
  private async readParts(
    source: SourceRef,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const length = end - start + 1n;
    const count = BigInt(Math.max(1, Math.floor(this.parts)));
    // Parts under 256 KiB cost more in round trips than they save.
    if (count === 1n || length < count * 262144n)
      return this.read(source, start, end, signal);
    const size = (length + count - 1n) / count;
    const inner = new AbortController();
    const stop = () => inner.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const ranges: Array<[bigint, bigint]> = [];
      for (let from = start; from <= end; from += size)
        ranges.push([from, from + size - 1n < end ? from + size - 1n : end]);
      const pieces = await Promise.all(
        ranges.map(([from, to]) =>
          this.read(source, from, to, inner.signal).catch((error: unknown) => {
            // One part that cannot be read makes the block unreadable.
            inner.abort();
            throw error;
          }),
        ),
      );
      return Buffer.concat(pieces);
    } finally {
      signal.removeEventListener("abort", stop);
    }
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
    let failures = 0,
      limits = 0;
    for (;;) {
      // After one request is told to slow down, the others wait it out too.
      const cooling = this.coolUntil - Date.now();
      if (cooling > 0) await delay(cooling, undefined, { signal });
      await this.slot(source, signal);
      let outcome: { bytes: Uint8Array } | { error: unknown };
      try {
        outcome = { bytes: await this.attempt(source, start, end, signal) };
      } catch (error) {
        outcome = { error };
      } finally {
        this.release();
      }
      if ("bytes" in outcome) return outcome.bytes;
      const { error } = outcome;
      if (signal.aborted || error instanceof PermanentSourceError) throw error;
      let wait: number;
      if (error instanceof RateLimitedSource) {
        if (++limits >= RATE_LIMIT_ATTEMPTS) throw error;
        wait = Math.min(
          this.rateLimitDelayMs * 2 ** (limits - 1) +
            Math.random() * this.rateLimitDelayMs,
          RATE_LIMIT_MAX_MS,
        );
        this.coolUntil = Math.max(this.coolUntil, Date.now() + wait);
      } else {
        if (++failures >= 3) throw error;
        wait =
          this.retryDelayMs * 2 ** (failures - 1) +
          Math.random() * this.retryDelayMs;
      }
      await delay(wait, undefined, { signal });
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
      throw limited || response.status === 429
        ? new RateLimitedSource(message)
        : response.status >= 500
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
