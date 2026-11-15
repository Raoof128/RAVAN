import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { openDatabase, type Database } from "../../../packages/db/src/open.js";
import { environmentConfig } from "../../api/src/config.js";
import { JobQueue } from "./leases.js";
import { prepareBrowser } from "./browser-prepare.js";
import { verifyBoundary, makeRoom, ASSET_ID } from "./prepared-store.js";
import { conversionPlan, qualities } from "./compatibility.js";
import { MediaPlanner } from "../../api/src/media/planner.js";
import { rm, statfs } from "node:fs/promises";
import { mediaFailureCode } from "./process.js";
import { probeMedia } from "./probe.js";
const sourceSchema = z.strictObject({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.string().regex(/^\d+$/),
});
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
    },
  ) {
    this.queue = new JobQueue(db);
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw new Error("Worker input must use loopback");
  }
  async queueLibrary() {
    if (!this.storage) return;
    const sources = this.db
      .prepare(
        "SELECT id AS fileId,generation,size_bytes AS sizeBytes FROM source_files WHERE available=1 ORDER BY size_bytes+0 LIMIT 1000",
      )
      .all() as Array<z.infer<typeof sourceSchema>>;
    const planner = new MediaPlanner(this.db, true, this.storage.directory);
    for (const source of sources)
      await planner.planPlayback(
        source,
        {
          id: "web",
          platform: "web",
          verified: false,
        },
        {},
        true,
      );
  }
  async runNextJob(
    signal: AbortSignal,
  ): Promise<"idle" | "completed" | "retry"> {
    const job = this.queue.claim();
    if (!job) return "idle";
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const renewal = setInterval(() => {
      try {
        this.queue.renew(job);
      } catch {
        controller.abort();
      }
    }, 10000);
    renewal.unref();
    try {
      if (job.kind === "browser-prepare") {
        if (!this.storage) throw new Error("Preparation unavailable");
        const data = z
          .object({
            source: sourceSchema,
            quality: z.enum(qualities),
            forceEncode: z.boolean().default(false),
            audio: z.number().int().min(0).max(99),
            id: z.string().regex(ASSET_ID),
          })
          .parse(JSON.parse(job.payload));
        await verifyBoundary(
          this.storage.directory,
          this.storage.dataDir,
          this.storage.production,
        );
        const record = this.db
          .prepare("SELECT metadata FROM tracks WHERE id=?")
          .get(`probe-${data.source.fileId}`) as
          { metadata: string } | undefined;
        if (!record) throw new Error("Probe missing");
        const parsed = JSON.parse(record.metadata);
        if (parsed.generation !== data.source.generation)
          throw new Error("Source changed");
        const verify = async () => {
          const r = await fetch(
            `${this.origin}/_worker/verify/${data.source.fileId}`,
            {
              headers: { authorization: `Bearer ${this.key}` },
              signal: AbortSignal.any([combined, AbortSignal.timeout(15000)]),
              redirect: "error",
            },
          );
          if (
            !r.ok ||
            sourceSchema.parse(await r.json()).generation !==
              data.source.generation
          )
            throw new Error("Source changed");
        };
        await verify();
        const plan = conversionPlan(
          parsed.probe,
          data.quality,
          data.forceEncode,
        );
        const estimate = plan.copyVideo
          ? Number(data.source.sizeBytes) * 1.05
          : ((((plan.bitrate * 1000) / 8 + 24000) * parsed.probe.durationMs) /
              1000) *
            1.15;
        const needed = Math.ceil(
          Math.min(18 * 1024 ** 3, Math.max(64 * 1024 ** 2, estimate)),
        );
        await makeRoom(this.db, this.storage.directory, needed);
        const space = await statfs(this.storage.directory, { bigint: true });
        const maxBytes = Math.min(
          18 * 1024 ** 3,
          Number(space.bavail * space.bsize) - 256 * 1024 ** 2,
        );
        const output = join(this.storage.directory, data.id);
        await rm(output, { recursive: true, force: true });
        this.db
          .prepare("UPDATE prepared_assets SET state='preparing' WHERE id=?")
          .run(data.id);
        const result = await prepareBrowser(
          `${this.origin}/_worker/source/${data.source.fileId}`,
          output,
          parsed.probe,
          data.quality,
          data.audio,
          combined,
          {
            headers: `Authorization: Bearer ${this.key}\r\n`,
            maxBytes,
            forceEncode: data.forceEncode,
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
                "UPDATE prepared_assets SET state='ready',size_bytes=?,subtitles=?,label=?,last_used=? WHERE id=?",
              )
              .run(
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
        return "completed";
      }
      if (job.kind !== "probe") throw new Error("Unknown media job");
      const source = sourceSchema.parse(JSON.parse(job.payload));
      const probe = await probeMedia(
        `${this.origin}/_worker/source/${source.fileId}`,
        combined,
        `Authorization: Bearer ${this.key}\r\n`,
      );
      combined.throwIfAborted();
      const response = await fetch(
        `${this.origin}/_worker/verify/${source.fileId}`,
        {
          headers: { authorization: `Bearer ${this.key}` },
          signal: AbortSignal.any([combined, AbortSignal.timeout(15000)]),
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("Source unavailable");
      const verified = sourceSchema.parse(await response.json());
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
              version: 2,
            }),
          );
      })();
      return "completed";
    } catch (error) {
      this.queue.fail(job, mediaFailureCode(error));
      return "retry";
    } finally {
      clearInterval(renewal);
      controller.abort();
    }
  }
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
          }
        : undefined,
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    while (!controller.signal.aborted) {
      await worker.queueLibrary();
      await worker.runNextJob(controller.signal);
      await delay(2000, undefined, { signal: controller.signal }).catch(
        () => {},
      );
    }
  } catch {
    console.error("Media worker failed; check local configuration.");
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
