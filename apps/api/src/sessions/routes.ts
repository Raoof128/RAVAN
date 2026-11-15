import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import type { AppConfig } from "../config.js";
import type { LibrarySync } from "../drive/sync.js";
import type { BlockCache } from "../media/cache.js";
import {
  playbackSchema,
  progressSchema,
  idSchema,
} from "../../../../packages/contracts/src/schemas.js";
import { PlaybackService } from "./playback.js";
import { PairingService } from "./pairing.js";
import { principal, revokeDevice } from "./devices.js";
import { MediaPlanner } from "../media/planner.js";
import { localReader, ASSET_ID } from "../../../worker/src/prepared-store.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { sendRaw } from "../media/raw-route.js";
export function registerSessions(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  library: LibrarySync,
  cache: BlockCache,
) {
  const planner = new MediaPlanner(
    db,
    Boolean(config.workerKey),
    config.preparedDir,
  );
  const playback = new PlaybackService(
    db,
    (id) => library.verifySource(id),
    (source, profile, options) =>
      planner.planPlayback(
        source,
        {
          id: profile,
          platform:
            profile === "web" ? "web" : profile === "lg-c1" ? "webos" : "tizen",
          verified: false,
        },
        options,
      ),
  );
  app.post("/api/playback", async (request, reply) => {
    const body = playbackSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    try {
      const r = await playback.create(
        body.data.movieId,
        body.data.profileId,
        body.data.startMs,
        principal(db, request),
        body.data.replaceSessionId,
        {
          quality: body.data.quality,
          audioTrack: body.data.audioTrack,
          forceCompatible: body.data.forceCompatible,
        },
      );
      return reply
        .code(
          r.kind === "conflict"
            ? 409
            : r.kind === "preparing"
              ? 202
              : r.kind === "unsupported"
                ? 422
                : 200,
        )
        .send(r);
    } catch {
      return reply.code(503).send({ error: "source_unavailable" });
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/playback/:id/heartbeat",
    async (request, reply) => {
      try {
        return await playback.heartbeat(
          request.params.id,
          principal(db, request),
        );
      } catch {
        return reply.code(403).send({ error: "session_unavailable" });
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/playback/:id",
    async (request, reply) => {
      playback.stop(request.params.id, principal(db, request));
      return reply.code(204).send();
    },
  );
  app.post("/api/progress", async (request, reply) => {
    const body = progressSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_progress" });
    return {
      status: playback.recordProgress(body.data, principal(db, request)),
    };
  });
  app.get<{ Params: { ticket: string; "*": string } }>(
    "/media/s/:ticket/*",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const { ticket } = request.params;
        const path = request.params["*"];
        const ref = await playback.authorizeMedia(ticket, path);
        if (ref.assetId) {
          if (!config.preparedDir || !ASSET_ID.test(ref.assetId))
            throw Error("Media denied");
          const file = await lstat(join(config.preparedDir, ref.assetId, path));
          if (!file.isFile() || file.isSymbolicLink())
            throw Error("Media denied");
          return await sendRaw(
            request,
            reply,
            {
              fileId: ref.assetId,
              generation: ref.assetId,
              sizeBytes: String(file.size),
            },
            localReader(config.preparedDir, path),
            async () => {
              await playback.authorizeMedia(ticket, path);
            },
            path.endsWith(".vtt") ? "text/vtt; charset=utf-8" : "video/mp4",
          );
        }
        return await sendRaw(request, reply, ref, cache, async () => {
          await playback.authorizeMedia(ticket, path);
        });
      } catch {
        return reply.code(403).send({ error: "media_denied" });
      }
    },
  );
  app.get("/api/devices", async () =>
    db
      .prepare(
        "SELECT id,name FROM devices WHERE revoked_at IS NULL ORDER BY name",
      )
      .all(),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/devices/:id",
    async (request, reply) => {
      revokeDevice(db, request.params.id);
      return reply.code(204).send();
    },
  );
  const pairing = config.encryptionKey
    ? new PairingService(db, Buffer.from(config.encryptionKey, "hex"))
    : undefined;
  app.post(
    "/api/pairing",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .strictObject({ name: z.string().trim().min(1).max(80) })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!pairing)
        return reply.code(503).send({ error: "pairing_not_configured" });
      try {
        return pairing.create(body.data.name);
      } catch {
        return reply.code(429).send({ error: "try_later" });
      }
    },
  );
  app.post(
    "/api/pairing/approve",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .strictObject({ code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/) })
        .safeParse(request.body);
      if (!body.success || !pairing)
        return reply.code(400).send({ error: "pairing_unavailable" });
      try {
        pairing.approve(body.data.code);
        return reply.code(204).send();
      } catch {
        return reply.code(400).send({ error: "pairing_unavailable" });
      }
    },
  );
  app.post(
    "/api/pairing/poll",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .strictObject({
          id: idSchema,
          pollSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        })
        .safeParse(request.body);
      if (!body.success || !pairing)
        return reply.code(400).send({ error: "pairing_unavailable" });
      try {
        return pairing.poll(body.data.id, body.data.pollSecret);
      } catch {
        return reply.code(400).send({ error: "pairing_unavailable" });
      }
    },
  );
  app.post("/api/pairing/ack", async (request, reply) => {
    const body = z.strictObject({ id: idSchema }).safeParse(request.body);
    if (!body.success || !pairing)
      return reply.code(400).send({ error: "pairing_unavailable" });
    try {
      pairing.ack(body.data.id, (request.headers.authorization ?? "").slice(7));
      return reply.code(204).send();
    } catch {
      return reply.code(400).send({ error: "pairing_unavailable" });
    }
  });
  return playback;
}
