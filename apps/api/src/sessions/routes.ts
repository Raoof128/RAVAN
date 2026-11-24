import { preparationStatus } from "../media/native-preparations.js";
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
import { PairingService, listedDevices } from "./pairing.js";
import { deviceCredential, principal, revokeDevice } from "./devices.js";
import { MediaPlanner } from "../media/planner.js";
import { localReader, ASSET_ID } from "../../../worker/src/prepared-store.js";
import { lstat, readFile } from "node:fs/promises";
import { servePlaylist } from "../../../worker/src/hls.js";
import { join } from "node:path";
import { sendRaw } from "../media/raw-route.js";
export function registerSessions(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  library: LibrarySync,
  cache: BlockCache,
) {
  app.get("/api/capabilities", async (_request, reply) => {
    if (
      !config.encryptionKey ||
      !config.ownerSubject ||
      !config.clientId ||
      !config.clientSecret ||
      !config.origin.startsWith("https://")
    )
      return reply.code(503).send({ error: "server_not_configured" });
    const { id } = db
      .prepare("SELECT id FROM server_identity WHERE singleton=1")
      .get() as { id: string };
    return {
      protocolMajor: 1,
      instanceId: id,
      profiles: ["apple-sdr-v1"],
      mediaOrigins: [new URL(config.origin).origin],
      features: {
        continueWatching: true,
        watchlistWrite: true,
        editionSelection: true,
        preparationStatus: true,
        selfRevocation: true,
        readingRoom: true,
      },
    };
  });
  const planner = new MediaPlanner(
    db,
    Boolean(config.workerKey),
    config.preparedDir,
    Date.now,
    {
      format: config.preparedFormat,
      capacityBytes: config.preparedCapacityBytes,
    },
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
            profile === "apple-sdr-v1"
              ? "apple"
              : profile === "web"
                ? "web"
                : profile === "lg-c1"
                  ? "webos"
                  : "tizen",
          verified: false,
        },
        options,
      ),
  );
  // The owner's own: what choosing each picture would do to the prepared films.
  app.get<{ Params: { id: string } }>(
    "/api/movies/:id/pictures",
    async (request, reply) => {
      const id = idSchema.safeParse(request.params.id);
      if (!id.success)
        return reply.code(400).send({ error: "invalid_request" });
      const source = db
        .prepare(
          "SELECT id fileId,generation,CAST(size_bytes AS TEXT) sizeBytes FROM source_files WHERE movie_id=? AND available=1",
        )
        .all(id.data) as Array<{
        fileId: string;
        generation: string;
        sizeBytes: string;
      }>;
      if (source.length !== 1) return { items: [] };
      return { items: await planner.pictureChoices(source[0]!) };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/preparations/:id",
    async (request, reply) => {
      const status =
        /^[a-f0-9]{64}$/.test(request.params.id) &&
        preparationStatus(db, principal(db, request), request.params.id);
      if (!status)
        return reply.code(404).send({ error: "preparation_unavailable" });
      return status;
    },
  );
  app.post("/api/playback", async (request, reply) => {
    const body = playbackSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    try {
      const who = principal(db, request);
      // Only the owner's browser session sets what background work plans for.
      // The profile name is the client's claim; the session is not.
      if (who.webHash && body.data.capabilities)
        planner.rememberCapabilities(body.data.capabilities);
      const r = await playback.create(
        body.data.movieId,
        body.data.profileId,
        body.data.startMs,
        who,
        body.data.replaceSessionId,
        {
          quality: body.data.quality,
          editionId: body.data.editionId,
          generation: body.data.generation,
          audioTrack: body.data.audioTrack,
          forceCompatible: body.data.forceCompatible,
          capabilities: body.data.capabilities,
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
          if (path.endsWith(".m3u8")) {
            // A playlist is replaced as the edition grows, so it is read whole,
            // and only the strict form this server writes is passed on.
            if (file.size > 2 * 1024 * 1024) throw Error("Media denied");
            // Checked before the reply is typed: a refusal must go out as JSON.
            const text = servePlaylist(
              path,
              await readFile(
                join(config.preparedDir, ref.assetId, path),
                "utf8",
              ),
            );
            return reply.type("application/vnd.apple.mpegurl").send(text);
          }
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
            path.endsWith(".vtt")
              ? "text/vtt; charset=utf-8"
              : path.endsWith(".m4s")
                ? "video/iso.segment"
                : "video/mp4",
          );
        }
        // Browsers that play WebM or Matroska originals expect them labelled.
        const stored = (
          db
            .prepare("SELECT mime_type FROM source_files WHERE id=?")
            .get(ref.fileId) as { mime_type: string | null } | undefined
        )?.mime_type;
        return await sendRaw(
          request,
          reply,
          ref,
          cache,
          async () => {
            await playback.authorizeMedia(ticket, path);
          },
          stored === "video/webm" || stored === "video/x-matroska"
            ? stored
            : "video/mp4",
        );
      } catch {
        return reply.code(403).send({ error: "media_denied" });
      }
    },
  );
  app.get("/api/devices", async () => listedDevices(db));
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
  if (pairing) {
    // Hourly, as well as whenever a screen asks to pair.
    const tidy = setInterval(() => {
      try {
        pairing.expire();
      } catch {
        /* A busy database is retried next hour. */
      }
    }, 3600000);
    tidy.unref();
    app.addHook("onClose", async () => clearInterval(tidy));
  }
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
        .strictObject({
          code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),
          watchlistWrite: z.boolean().default(false),
          reading: z.boolean().default(false),
        })
        .safeParse(request.body);
      if (!body.success || !pairing)
        return reply.code(400).send({ error: "pairing_unavailable" });
      try {
        pairing.approve(
          body.data.code,
          body.data.watchlistWrite,
          body.data.reading,
        );
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
      } catch (error) {
        if (error instanceof Error && error.message === "Poll too quickly")
          return reply
            .header("Retry-After", "5")
            .code(429)
            .send({ error: "try_later" });
        return reply.code(400).send({ error: "pairing_unavailable" });
      }
    },
  );
  app.post("/api/pairing/ack", async (request, reply) => {
    const body = z.strictObject({ id: idSchema }).safeParse(request.body);
    const credential = deviceCredential(request);
    if (!body.success || !pairing || !credential)
      return reply.code(400).send({ error: "pairing_unavailable" });
    try {
      pairing.ack(body.data.id, credential);
      return reply.code(204).send();
    } catch {
      return reply.code(400).send({ error: "pairing_unavailable" });
    }
  });
  // "Disconnect this TV": the screen gives up its own credential, so it does
  // not stay valid on the server after the screen has forgotten it.
  app.post("/api/pairing/forget", async (request, reply) => {
    const who = principal(db, request);
    if (!who.deviceId)
      return reply.code(400).send({ error: "pairing_unavailable" });
    revokeDevice(db, who.deviceId);
    return reply.code(204).send();
  });
  app.delete("/api/devices/self", async (request, reply) => {
    const who = principal(db, request);
    if (!who.deviceId)
      return reply.code(403).send({ error: "device_required" });
    revokeDevice(db, who.deviceId);
    return reply.code(204).send();
  });
  return playback;
}
