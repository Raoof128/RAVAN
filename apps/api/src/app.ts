import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { verifyBoundary } from "../../worker/src/prepared-store.js";
import { mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { openDatabase } from "../../../packages/db/src/open.js";
import { registerAuth } from "./auth/routes.js";
import type { OAuthProvider } from "./auth/oauth.js";
import { registerLibrary } from "./library/import.js";
import { DriveError, type DriveClient } from "./drive/client.js";
import { BlockCache } from "./media/cache.js";
import { DriveSourceReader } from "./media/source-stream.js";
import { sendRaw } from "./media/raw-route.js";
import { equal, hash, secret } from "./auth/sessions.js";
import { z } from "zod";
import { registerSessions } from "./sessions/routes.js";
import { registerCatalogue } from "./library/routes.js";

export async function buildApp(
  config: AppConfig,
  options: {
    oauthProvider?: OAuthProvider;
    driveClient?: DriveClient;
    sourceFetch?: typeof fetch;
  } = {},
) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (config.preparedDir)
    await verifyBoundary(
      config.preparedDir,
      config.dataDir,
      config.mode === "production",
      config.preparedCapacityBytes,
    );
  const db = openDatabase(join(config.dataDir, "mov.sqlite"));
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    // Production accepts only the local Nginx hop, which overwrites forwarded identity.
    trustProxy: config.mode === "production" ? ["127.0.0.1"] : false,
  });
  app.decorate("database", db);
  app.addHook("onClose", async () => {
    db.close();
  });
  // Expired sessions and long-ended playback rows are dead weight. The newest
  // playback row always stays: progress ordering depends on its epoch.
  const prune = () => {
    const now = Date.now();
    db.transaction(() => {
      db.prepare("DELETE FROM web_sessions WHERE expires_at<=?").run(now);
      db.prepare("DELETE FROM media_ticket_grace WHERE expires_at<=?").run(now);
      db.prepare(
        "DELETE FROM playback_sessions WHERE expires_at<=? AND epoch<(SELECT MAX(epoch) FROM playback_sessions) AND id NOT IN (SELECT session_id FROM media_ticket_grace)",
      ).run(now - 30 * 86400000);
    })();
  };
  prune();
  const housekeeping = setInterval(() => {
    try {
      prune();
    } catch {
      /* A busy database is retried next hour. */
    }
  }, 3600000);
  housekeeping.unref();
  app.addHook("onClose", async () => clearInterval(housekeeping));
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    // Packaged TVs use an opaque file origin. CORS never permits browser cookies;
    // device requests still require bearer authorization on every private route.
    const origin = request.headers.origin;
    if (
      origin === "null" &&
      (request.routeOptions.url ?? "").startsWith("/api/")
    ) {
      reply
        .header("Access-Control-Allow-Origin", "null")
        .header("Vary", "Origin");
      if (request.method === "OPTIONS")
        return reply
          .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
          .header("Access-Control-Allow-Methods", "GET, POST, DELETE")
          .code(204)
          .send();
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status >= 400 && status < 600 ? status : 500).send({
      error:
        status === 429
          ? "rate_limited"
          : status < 500
            ? "invalid_request"
            : "internal_error",
    });
  });
  // Same fixed shape as every other error; the default body echoes the request path.
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not_found" }),
  );
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      db.prepare("SELECT 1").get();
      db.transaction(() => {
        db.prepare(
          "UPDATE schema_migrations SET applied_at=applied_at WHERE version=1",
        ).run();
      })();
      const fs = await statfs(config.dataDir, { bigint: true });
      if (fs.bavail * fs.bsize < BigInt(config.minFreeBytes))
        throw new Error("disk reserve");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  registerAuth(app, db, config, options.oauthProvider);
  const library = registerLibrary(app, db, config, options.driveClient);
  const source = new DriveSourceReader(
    app.getDecorator<() => Promise<string>>("getDriveAccessToken"),
    (id, fresh) => library.verifySource(id, fresh),
    options.sourceFetch,
  );
  const cache = new BlockCache(
    db,
    join(config.dataDir, "source-cache"),
    {
      maxBytes: 20n * 1024n ** 3n,
      minFreeBytes: BigInt(config.minFreeBytes),
      readAhead: 2,
    },
    (ref, start, end, signal) => source.block(ref, start, end, signal),
  );
  await cache.init();
  registerSessions(app, db, config, library, cache);
  registerCatalogue(app, db);
  if (config.workerKey) {
    const workerAuth = async (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => {
      if (
        !equal(
          request.headers.authorization ?? "",
          `Bearer ${config.workerKey}`,
        )
      )
        return reply.code(401).send({ error: "authentication_required" });
    };
    // These routes are authenticated by key or grant and reached only from
    // loopback; back-to-back probes would trip the per-address limit meant for
    // the public routes.
    const unlimited = { rateLimit: false as const };
    // The worker must tell "this film is gone" from "ask again later": the
    // first is a verdict on the job, the second must not cost it an attempt.
    const verified = async (
      reply: import("fastify").FastifyReply,
      id: string,
      fresh: boolean,
    ) => {
      try {
        return await library.verifySource(id, fresh);
      } catch (error) {
        const gone =
          (error instanceof DriveError &&
            (error.status === 403 || error.status === 404)) ||
          (error instanceof Error &&
            /^Source (unavailable|changed or unavailable|metadata incomplete)$/.test(
              error.message,
            )) ||
          error instanceof z.ZodError;
        reply
          .code(gone ? 410 : 503)
          .send({ error: gone ? "source_unavailable" : "try_later" });
        return;
      }
    };
    app.get<{ Params: { id: string } }>(
      "/_worker/verify/:id",
      { preHandler: workerAuth, config: unlimited },
      // The worker asks before and after a conversion; always consult Drive.
      async (request, reply) => verified(reply, request.params.id, true),
    );
    // FFmpeg and FFprobe take their credential on the command line, where any
    // local user can read it. They are given a grant for one file that expires,
    // never the worker key, which reaches every source and does not expire.
    const grants = new Map<string, { fileId: string; expires: number }>();
    // An inspection needs minutes; a conversion may run for two days.
    const GRANT_MS = { short: 600000, long: 49 * 3600000 };
    app.post<{ Params: { id: string }; Querystring: { life?: string } }>(
      "/_worker/grant/:id",
      { preHandler: workerAuth, config: unlimited },
      async (request, reply) => {
        const ref = await verified(reply, request.params.id, true);
        if (!ref) return;
        const now = Date.now();
        for (const [key, grant] of grants)
          if (grant.expires <= now) grants.delete(key);
        // Far above what two lanes hold; short grants expire long before this.
        while (grants.size >= 64)
          grants.delete(grants.keys().next().value as string);
        const token = secret();
        grants.set(hash(token), {
          fileId: ref.fileId,
          expires:
            now + GRANT_MS[request.query.life === "long" ? "long" : "short"],
        });
        return { token };
      },
    );
    app.delete(
      "/_worker/grant",
      { preHandler: workerAuth, config: unlimited },
      async (request, reply) => {
        const body = z
          .strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .safeParse(request.body);
        if (body.success) grants.delete(hash(body.data.token));
        return reply.code(204).send();
      },
    );
    app.get<{ Params: { id: string } }>(
      "/_worker/source/:id",
      {
        config: unlimited,
        preHandler: async (request, reply) => {
          const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
            request.headers.authorization ?? "",
          );
          const grant = match && grants.get(hash(match[1]!));
          if (
            !grant ||
            grant.expires <= Date.now() ||
            grant.fileId !== request.params.id
          )
            return reply.code(401).send({ error: "authentication_required" });
        },
      },
      async (request, reply) => {
        const ref = await verified(reply, request.params.id, false);
        if (!ref) return;
        return sendRaw(request, reply, ref, cache, async () => {
          await library.verifySource(ref.fileId);
        });
      },
    );
  }
  app.all("/api/*", async (_request, reply) =>
    reply.code(404).send({ error: "not_found" }),
  );
  return app;
}
