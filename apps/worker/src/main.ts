import { pathToFileURL } from "node:url";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { openDatabase, type Database } from "../../../packages/db/src/open.js";
import { environmentConfig, startupReason } from "../../api/src/config.js";
import { JobQueue, type Lane } from "./leases.js";
import { prepareBrowser } from "./browser-prepare.js";
import {
  pruneStale,
  verifyBoundary,
  makeRoom,
  ASSET_ID,
  CAPACITY,
} from "./prepared-store.js";
import { conversionPlan, qualities } from "./compatibility.js";
import {
  MediaPlanner,
  storedCapabilities,
} from "../../api/src/media/planner.js";
import { rm, statfs } from "node:fs/promises";
import { mediaFailureCode } from "./process.js";
import { probeMedia, probeRecord, PROBE_VERSION } from "./probe.js";
import {
  artworkDirectory,
  extractArtwork,
  storeArtwork,
  sweepArtwork,
} from "./artwork.js";
/** Bump to make every film's pictures again, for example after a better method. */
export const ARTWORK_VERSION = 1;
const sourceSchema = z.strictObject({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.string().regex(/^\d+$/),
});
/**
 * The API could not answer: it is restarting, rate limiting, or cannot reach
 * Drive. That says nothing about the film, so the job is put back unharmed
 * rather than charged an attempt.
 */
class ApiUnavailable extends Error {}
export class MediaWorker {
  private queue: JobQueue;
  constructor(
    private db: Database,
    private origin: string,
    private key: string,
    private storage?: {
      directory: string;
      dataDir: string;
      production: boolean;
      threads?: number;
      preset?: string;
      format?: "mp4" | "hls";
      capacityBytes?: number;
    },
    private renewMs = 10000,
  ) {
    this.queue = new JobQueue(db);
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw new Error("Worker input must use loopback");
  }
  private swept = 0;
  async queueLibrary() {
    if (!this.storage) return;
    // Once an hour, remove picture files that nothing refers to.
    if (Date.now() - this.swept > 3600000) {
      this.swept = Date.now();
      await sweepArtwork(this.db, artworkDirectory(this.storage.dataDir)).catch(
        () => 0,
      );
      // Editions of content that has since changed can never play again.
      await pruneStale(this.db, this.storage.directory).catch(() => 0);
    }
    // Pictures for each film once it has been inspected: one source per film,
    // made again when the file changes.
    const queue = this.queue;
    this.db.transaction(() => {
      const missing = this.db
        .prepare(
          `SELECT s.id fileId,s.generation,s.size_bytes sizeBytes,s.movie_id movieId FROM source_files s JOIN tracks t ON t.id='probe-'||s.id
           WHERE s.available=1 AND json_extract(t.metadata,'$.generation')=s.generation
           AND s.id=(SELECT min(id) FROM source_files o WHERE o.movie_id=s.movie_id AND o.available=1)
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.unique_key='artwork-v${ARTWORK_VERSION}:'||s.id||':'||s.generation)
           LIMIT 100`,
        )
        .all() as Array<{
        fileId: string;
        generation: string;
        sizeBytes: string;
        movieId: string;
      }>;
      for (const film of missing)
        queue.enqueue(
          "artwork",
          `artwork-v${ARTWORK_VERSION}:${film.fileId}:${film.generation}`,
          {
            source: {
              fileId: film.fileId,
              generation: film.generation,
              sizeBytes: film.sizeBytes,
            },
            movieId: film.movieId,
          },
        );
    })();
    const sources = this.db
      .prepare(
        "SELECT id AS fileId,generation,size_bytes AS sizeBytes FROM source_files WHERE available=1 ORDER BY size_bytes+0 LIMIT 1000",
      )
      .all() as Array<z.infer<typeof sourceSchema>>;
    const planner = new MediaPlanner(
      this.db,
      true,
      this.storage.directory,
      Date.now,
      {
        format: this.storage.format,
        capacityBytes: this.storage.capacityBytes,
      },
    );
    const capabilities = storedCapabilities(this.db);
    const planned = new Set<string>();
    for (const source of sources) {
      const plan = await planner.planPlayback(
        source,
        {
          id: "web",
          platform: "web",
          verified: false,
        },
        capabilities ? { capabilities } : {},
        true,
      );
      if (plan.mode === "prepare") planned.add(plan.assetId);
    }
    // Once the browser has said what it plays, conversions queued before that
    // for films it can now play directly or repackage are hours of wasted work.
    // Drop background jobs nobody asked for that are not running. A queued job
    // holds no partial work, whatever its attempt count: each attempt starts over.
    if (capabilities && sources.length < 1000)
      this.db.transaction(() => {
        const stale = this.db
          .prepare(
            "SELECT id,payload FROM jobs WHERE kind='browser-prepare' AND state='queued' AND priority=0",
          )
          .all() as Array<{ id: string; payload: string }>;
        for (const job of stale) {
          if (planned.has(job.id)) continue;
          const asset = z
            .object({ id: z.string().regex(ASSET_ID) })
            .safeParse(JSON.parse(job.payload));
          this.db.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
          if (asset.success)
            this.db
              .prepare(
                "DELETE FROM prepared_assets WHERE id=? AND state IN ('queued','preparing')",
              )
              .run(asset.data.id);
        }
      })();
  }
  /** Ask the API about a source. Only a definite answer is a verdict on the film. */
  private async ask(
    path: string,
    method: "GET" | "POST",
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiUnavailable("API unreachable");
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new ApiUnavailable("API unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Source changed");
    }
    return response.json();
  }
  /** A credential FFmpeg may show on its command line: one file, and it expires. */
  private async grant(
    fileId: string,
    signal: AbortSignal,
    life: "short" | "long",
  ): Promise<string> {
    return z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(
        await this.ask(
          `/_worker/grant/${fileId}?life=${life}`,
          "POST",
          signal,
          45000,
        ),
      ).token;
  }
  private revoke(token: string) {
    void fetch(`${this.origin}/_worker/grant`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    }).catch(() => {});
  }
  async runNextJob(
    signal: AbortSignal,
    lane?: Lane,
  ): Promise<"idle" | "completed" | "retry"> {
    const job = this.queue.claim(lane);
    if (!job) return "idle";
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let yielded = false;
    const renewal = setInterval(() => {
      try {
        this.queue.renew(job);
        // Make way when a viewer is now waiting on a different film.
        if (
          job.kind !== "probe" &&
          job.kind !== "artwork" &&
          this.queue.shouldYield(job)
        ) {
          yielded = true;
          controller.abort();
        }
      } catch {
        controller.abort();
      }
    }, this.renewMs);
    renewal.unref();
    let granted: string | undefined;
    let preparing: { id: string; output: string } | undefined;
    try {
      if (job.kind === "browser-prepare") {
        if (!this.storage) throw new Error("Preparation unavailable");
        const data = z
          .object({
            source: sourceSchema,
            quality: z.enum(qualities),
            forceEncode: z.boolean().default(false),
            audio: z.number().int().min(0).max(99),
            video: z.array(z.string().max(16)).max(8).optional(),
            format: z.enum(["mp4", "hls"]).default("mp4"),
            // Every audio track, each its own stream (HLS only).
            allAudio: z.boolean().default(false),
            id: z.string().regex(ASSET_ID),
          })
          .parse(JSON.parse(job.payload));
        const capacity = this.storage.capacityBytes ?? CAPACITY;
        // One edition may use the volume less a margin for its neighbours.
        const largest = Math.max(1024 ** 3, capacity - 2 * 1024 ** 3);
        await verifyBoundary(
          this.storage.directory,
          this.storage.dataDir,
          this.storage.production,
          capacity,
        );
        const record = this.db
          .prepare("SELECT metadata FROM tracks WHERE id=?")
          .get(`probe-${data.source.fileId}`) as
          { metadata: string } | undefined;
        if (!record) throw new Error("Probe missing");
        const parsed = probeRecord.parse(JSON.parse(record.metadata));
        if (parsed.generation !== data.source.generation)
          throw new Error("Source changed");
        const verify = async () => {
          const verified = sourceSchema.parse(
            await this.ask(
              `/_worker/verify/${data.source.fileId}`,
              "GET",
              combined,
              45000,
            ),
          );
          if (verified.generation !== data.source.generation)
            throw new Error("Source changed");
        };
        await verify();
        granted = await this.grant(data.source.fileId, combined, "long");
        const plan = conversionPlan(
          parsed.probe,
          data.quality,
          data.forceEncode,
          data.video,
        );
        const estimate = plan.copyVideo
          ? Number(data.source.sizeBytes) * 1.05
          : ((((plan.bitrate * 1000) / 8 + 24000) * parsed.probe.durationMs) /
              1000) *
            1.15;
        const needed = Math.ceil(
          Math.min(largest, Math.max(64 * 1024 ** 2, estimate)),
        );
        await makeRoom(this.db, this.storage.directory, needed);
        const space = await statfs(this.storage.directory, { bigint: true });
        const maxBytes = Math.min(
          largest,
          Number(space.bavail * space.bsize) - 256 * 1024 ** 2,
        );
        const output = join(this.storage.directory, data.id);
        await rm(output, { recursive: true, force: true });
        this.db
          .prepare(
            "UPDATE prepared_assets SET state='preparing',format=? WHERE id=?",
          )
          .run(data.format, data.id);
        preparing = { id: data.id, output };
        const result = await prepareBrowser(
          `${this.origin}/_worker/source/${data.source.fileId}`,
          output,
          parsed.probe,
          data.quality,
          data.audio,
          combined,
          {
            headers: `Authorization: Bearer ${granted}\r\n`,
            maxBytes,
            forceEncode: data.forceEncode,
            videoCaps: data.video,
            threads: this.storage.threads,
            preset: this.storage.preset,
            format: data.format,
            allAudio: data.allAudio,
            // Enough exists to start watching while the rest is produced.
            playable: () => {
              this.db
                .prepare(
                  "UPDATE prepared_assets SET state='streaming' WHERE id=? AND state='preparing'",
                )
                .run(data.id);
            },
            verify,
            progress: (percent) => {
              this.db
                .prepare(
                  "UPDATE jobs SET progress=? WHERE id=? AND state='running' AND lease_until=?",
                )
                .run(percent, job.id, job.lease_until);
            },
          },
        );
        try {
          this.db.transaction(() => {
            this.queue.complete(job);
            this.db
              .prepare(
                "UPDATE prepared_assets SET state='ready',format=?,size_bytes=?,subtitles=?,label=?,last_used=? WHERE id=?",
              )
              .run(
                result.format,
                result.sizeBytes,
                JSON.stringify(result.captions),
                result.label,
                Date.now(),
                data.id,
              );
            this.db
              .prepare("UPDATE jobs SET progress=100 WHERE id=?")
              .run(job.id);
          })();
        } catch (error) {
          await rm(output, { recursive: true, force: true });
          throw error;
        }
        preparing = undefined;
        return "completed";
      }
      if (job.kind === "artwork") {
        if (!this.storage) throw new Error("Artwork unavailable");
        const data = z
          .object({
            source: sourceSchema,
            movieId: z.string().min(1).max(200),
          })
          .parse(JSON.parse(job.payload));
        const record = this.db
          .prepare("SELECT metadata FROM tracks WHERE id=?")
          .get(`probe-${data.source.fileId}`) as
          { metadata: string } | undefined;
        if (!record) throw new Error("Probe missing");
        const parsed = probeRecord.parse(JSON.parse(record.metadata));
        if (parsed.generation !== data.source.generation)
          throw new Error("Source changed");
        const directory = artworkDirectory(this.storage.dataDir);
        granted = await this.grant(data.source.fileId, combined, "short");
        const pictures = await extractArtwork(
          `${this.origin}/_worker/source/${data.source.fileId}`,
          `Authorization: Bearer ${granted}\r\n`,
          parsed.probe,
          directory,
          combined,
        );
        try {
          const verified = sourceSchema.parse(
            await this.ask(
              `/_worker/verify/${data.source.fileId}`,
              "GET",
              combined,
              45000,
            ),
          );
          if (verified.generation !== data.source.generation)
            throw new Error("Source changed");
          // Both of the worker's sources in one step: never one without the other.
          await storeArtwork(
            this.db,
            directory,
            data.movieId,
            data.source.generation,
            ["cover", "frame"],
            pictures,
          );
        } catch (error) {
          await Promise.all(
            pictures.map((p) => rm(join(directory, p.file), { force: true })),
          );
          throw error;
        }
        this.queue.complete(job);
        return "completed";
      }
      if (job.kind !== "probe") throw new Error("Unknown media job");
      const source = sourceSchema.parse(JSON.parse(job.payload));
      granted = await this.grant(source.fileId, combined, "short");
      const probe = await probeMedia(
        `${this.origin}/_worker/source/${source.fileId}`,
        combined,
        `Authorization: Bearer ${granted}\r\n`,
      );
      combined.throwIfAborted();
      const verified = sourceSchema.parse(
        await this.ask(
          `/_worker/verify/${source.fileId}`,
          "GET",
          combined,
          45000,
        ),
      );
      if (verified.generation !== source.generation)
        throw new Error("Source changed");
      this.db.transaction(() => {
        this.queue.complete(job);
        this.db
          .prepare(
            "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES(?,?,'probe','metadata',?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
          )
          .run(
            `probe-${source.fileId}`,
            `source-${source.fileId}`,
            JSON.stringify({
              generation: source.generation,
              probe,
              version: PROBE_VERSION,
            }),
          );
      })();
      return "completed";
    } catch (error) {
      // An edition that was being streamed as it grew must stop being offered,
      // and nothing half-written may remain. Viewers of it are asked to wait.
      if (preparing) {
        const { id, output } = preparing;
        await rm(output, { recursive: true, force: true }).catch(() => {});
        try {
          this.db
            .prepare(
              "UPDATE prepared_assets SET state='queued' WHERE id=? AND state IN ('preparing','streaming')",
            )
            .run(id);
        } catch {
          /* makeRoom resets it before the next conversion. */
        }
      }
      // A stop requested by the service manager is not a fault in the media. Charging
      // it an attempt made three deploys during one long conversion fail it for good.
      // Crashes still count: an expired lease keeps its attempt in JobQueue.claim().
      // Yielding to a viewer's film is likewise no fault of this one.
      if (signal.aborted || yielded || error instanceof ApiUnavailable)
        this.queue.release(job);
      else this.queue.fail(job, mediaFailureCode(error));
      return "retry";
    } finally {
      clearInterval(renewal);
      controller.abort();
      if (granted) this.revoke(granted);
    }
  }
}
/**
 * The worker's three loops: plan the library, inspect films, convert films.
 * Each survives its own errors. One loop failing must not close the database
 * under a conversion another loop has been running for hours.
 */
export async function runLoops(
  worker: Pick<MediaWorker, "queueLibrary" | "runNextJob">,
  controller: AbortController,
  pause: (ms: number) => Promise<unknown>,
) {
  const { signal } = controller;
  const guarded = async (step: () => Promise<number>) => {
    // Counted per loop: a healthy lane must not hide a planner that never works.
    let failures = 0;
    while (!signal.aborted) {
      let wait: number;
      try {
        wait = await step();
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        console.error("Media worker step failed.", startupReason(error));
        // Persistent failure: stop cleanly and let the service manager restart.
        if (++failures >= 20) {
          process.exitCode = 1;
          controller.abort();
          return;
        }
        wait = 5000;
      }
      if (wait) await pause(wait);
    }
  };
  // Probes and conversions run side by side, one of each at a time. A job that
  // was put back waits before the next try, longer each time, so a restarting
  // API is ridden out instead of hammered.
  const lane = (name: Lane) => {
    let retries = 0;
    return guarded(async () => {
      const outcome = await worker.runNextJob(signal, name);
      if (outcome === "retry")
        return Math.min(60000, 5000 * 2 ** Math.min(retries++, 4));
      retries = 0;
      return outcome === "idle" ? 2000 : 0;
    });
  };
  await Promise.allSettled([
    guarded(async () => {
      await worker.queueLibrary();
      return 30000;
    }),
    lane("probe"),
    lane("prepare"),
    lane("artwork"),
  ]);
}
async function main() {
  let db: Database | undefined;
  try {
    const config = environmentConfig();
    if (!config.workerKey) throw new Error("Worker key required");
    db = openDatabase(join(config.dataDir, "mov.sqlite"));
    const worker = new MediaWorker(
      db,
      `http://127.0.0.1:${config.port}`,
      config.workerKey,
      config.preparedDir
        ? {
            directory: config.preparedDir,
            dataDir: config.dataDir,
            production: config.mode === "production",
            // One thread per CPU this service may use, unless configured.
            threads:
              config.encoderThreads ?? Math.min(4, availableParallelism()),
            preset: config.encoderPreset,
            format: config.preparedFormat,
            capacityBytes: config.preparedCapacityBytes,
          }
        : undefined,
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await runLoops(worker, controller, (ms) =>
      delay(ms, undefined, { signal: controller.signal }).catch(() => {}),
    );
  } catch (error) {
    console.error(
      "Media worker failed; check local configuration.",
      startupReason(error),
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
