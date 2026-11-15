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
import type { DriveClient } from "./drive/client.js";
import { BlockCache } from "./media/cache.js";
import { DriveSourceReader } from "./media/source-stream.js";
import { sendRaw } from "./media/raw-route.js";
import { equal } from "./auth/sessions.js";
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
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    // Packaged TVs use an opaque file origin. CORS never permits browser cookies;
    // device requests still require bearer authorization on every private route.
    const origin = request.headers.origin;
    if (origin === "null" && request.url.startsWith("/api/")) {
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
    reply
      .code(status >= 400 && status < 600 ? status : 500)
      .send({ error: status < 500 ? "invalid_request" : "internal_error" });
  });
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
    (id) => library.verifySource(id),
    options.sourceFetch,
  );
  const cache = new BlockCache(
    db,
    join(config.dataDir, "source-cache"),
    { maxBytes: 20n * 1024n ** 3n, minFreeBytes: BigInt(config.minFreeBytes) },
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
    app.get<{ Params: { id: string } }>(
      "/_worker/verify/:id",
      { preHandler: workerAuth },
      async (request) => library.verifySource(request.params.id),
    );
    app.get<{ Params: { id: string } }>(
      "/_worker/source/:id",
      { preHandler: workerAuth },
      async (request, reply) => {
        const ref = await library.verifySource(request.params.id);
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
