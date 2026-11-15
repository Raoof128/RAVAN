import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database } from "../../../../packages/db/src/open.js";
import type { SourceRef } from "../../../../packages/contracts/src/index.js";
import { StorageBudget } from "./budget.js";
type Options = { maxBytes: bigint; minFreeBytes: bigint; blockSize?: number };
type ReadBlock = (
  ref: SourceRef,
  start: bigint,
  end: bigint,
  signal: AbortSignal,
) => Promise<Uint8Array>;
type Flight = {
  promise: Promise<Uint8Array>;
  controller: AbortController;
  readers: number;
};
export class BlockCache {
  private flights = new Map<string, Flight>();
  private pins = new Map<string, number>();
  private budget: StorageBudget;
  private blockSize: bigint;
  constructor(
    private db: Database,
    private directory: string,
    private options: Options,
    private upstream: ReadBlock,
  ) {
    this.blockSize = BigInt(options.blockSize ?? 4 * 1024 * 1024);
    this.budget = new StorageBudget(
      directory,
      options.maxBytes,
      options.minFreeBytes,
      () =>
        BigInt(
          (
            db
              .prepare(
                "SELECT COALESCE(SUM(size_bytes),0) n FROM cache_blocks WHERE state='ready'",
              )
              .get() as { n: number }
          ).n,
        ),
    );
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rows = this.db
      .prepare("SELECT key FROM cache_blocks WHERE state='ready'")
      .all() as { key: string }[];
    const known = new Set(rows.map((r) => `${r.key}.block`));
    for (const name of await readdir(this.directory))
      if (!known.has(name)) await unlink(join(this.directory, name));
    for (const row of rows) {
      try {
        await stat(join(this.directory, `${row.key}.block`));
      } catch {
        this.db.prepare("DELETE FROM cache_blocks WHERE key=?").run(row.key);
      }
    }
    this.db.prepare("DELETE FROM cache_blocks WHERE state<>'ready'").run();
  }
  private async makeRoom(bytes: bigint) {
    while (true) {
      try {
        return await this.budget.reserveBytes("source", bytes);
      } catch (error) {
        const rows = this.db
          .prepare(
            "SELECT key FROM cache_blocks WHERE state='ready' ORDER BY last_used",
          )
          .all() as { key: string }[];
        const evict = rows.find(
          (r) => !this.pins.has(r.key) && !this.flights.has(r.key),
        );
        if (!evict) throw error;
        // Mark before awaiting unlink so simultaneous admissions cannot evict it twice.
        this.db
          .prepare("UPDATE cache_blocks SET state='evicting' WHERE key=?")
          .run(evict.key);
        try {
          await unlink(join(this.directory, `${evict.key}.block`));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        this.db.prepare("DELETE FROM cache_blocks WHERE key=?").run(evict.key);
      }
    }
  }
  private async load(
    ref: SourceRef,
    index: bigint,
    key: string,
    signal: AbortSignal,
  ) {
    const path = join(this.directory, `${key}.block`);
    const start = index * this.blockSize;
    const size = BigInt(ref.sizeBytes);
    const end =
      start + this.blockSize < size ? start + this.blockSize - 1n : size - 1n;
    const row = this.db
      .prepare(
        "SELECT size_bytes FROM cache_blocks WHERE key=? AND state='ready'",
      )
      .get(key) as { size_bytes: number } | undefined;
    if (row) {
      try {
        const data = await readFile(path);
        if (BigInt(data.length) !== end - start + 1n)
          throw new Error("Cache size mismatch");
        this.db
          .prepare("UPDATE cache_blocks SET last_used=? WHERE key=?")
          .run(Date.now(), key);
        return data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.db.prepare("DELETE FROM cache_blocks WHERE key=?").run(key);
      }
    }
    const reservation = await this.makeRoom(end - start + 1n);
    const partial = join(this.directory, `${key}.${randomUUID()}.partial`);
    try {
      const data = await this.upstream(ref, start, end, signal);
      signal.throwIfAborted();
      if (BigInt(data.length) !== end - start + 1n)
        throw new Error("Cache block length mismatch");
      await writeFile(partial, data, { flag: "wx", mode: 0o600, signal });
      signal.throwIfAborted();
      await rename(partial, path);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO cache_blocks VALUES(?,?,?,?,?,'ready',?)",
        )
        .run(
          key,
          ref.fileId,
          ref.generation,
          Number(index),
          data.length,
          Date.now(),
        );
      return data;
    } finally {
      await unlink(partial).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await reservation.release();
    }
  }
  private async block(ref: SourceRef, index: bigint, signal: AbortSignal) {
    signal.throwIfAborted();
    const key = createHash("sha256")
      .update(`${ref.fileId}:${ref.generation}:${index}`)
      .digest("hex");
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        readers: 0,
        promise: Promise.resolve(new Uint8Array()),
      };
      this.flights.set(key, flight);
      flight.promise = this.load(ref, index, key, controller.signal).finally(
        () => this.flights.delete(key),
      );
    }
    flight.readers++;
    let listener: () => void = () => {};
    try {
      return await Promise.race([
        flight.promise,
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(signal.reason ?? new Error("Cancelled"));
          signal.addEventListener("abort", listener, { once: true });
          if (signal.aborted) listener();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", listener);
      flight.readers--;
      if (!flight.readers) flight.controller.abort();
      const count = this.pins.get(key)! - 1;
      if (count) this.pins.set(key, count);
      else this.pins.delete(key);
    }
  }
  async *readSource(
    source: SourceRef,
    start: bigint,
    end: bigint,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    if (start < 0n || end >= BigInt(source.sizeBytes))
      throw new Error("Invalid source range");
    for (let offset = start; offset <= end;) {
      signal.throwIfAborted();
      const index = offset / this.blockSize;
      const data = await this.block(source, index, signal);
      const begin = Number(offset % this.blockSize);
      const length = Number(
        end - offset + 1n < BigInt(data.length - begin)
          ? end - offset + 1n
          : BigInt(data.length - begin),
      );
      yield data.subarray(begin, begin + length);
      offset += BigInt(length);
    }
  }
}
