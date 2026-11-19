import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { verifyBoundary } from "../../worker/src/prepared-store.js";
import { mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { startupReason, type AppConfig } from "./config.js";
import { lookupArtwork, TMDB_NOTICE } from "./media/tmdb.js";
import { openDatabase } from "../../../packages/db/src/open.js";
import { registerAuth } from "./auth/routes.js";
import type { OAuthProvider } from "./auth/oauth.js";
import { registerLibrary } from "./library/import.js";
import type { DriveClient } from "./drive/client.js";
import { sourceGone } from "./drive/sync.js";
import { BlockCache } from "./media/cache.js";
import { DriveSourceReader } from "./media/source-stream.js";
import { sendRaw } from "./media/raw-route.js";
import { equal, hash, secret } from "./auth/sessions.js";
import { z } from "zod";
import { registerSessions } from "./sessions/routes.js";
import { registerCatalogue } from "./library/routes.js";
import {
  BOOK_BLOCK_PARTS,
  BOOK_DRIVE_IN_FLIGHT,
  registerReading,
  warmReadingBlock,
} from "./library/reading.js";

export async function buildApp(
  config: AppConfig,
  options: {
    oauthProvider?: OAuthProvider;
    driveClient?: DriveClient;
    sourceFetch?: typeof fetch;
    /** How TMDB is reached; tests pass a fake. */
    artworkFetch?: typeof fetch;
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
    // A film being watched is a response with no end in sight. Waiting for it
    // made every stop last until the service manager killed the process, with
    // the database never closed. Players reconnect and resume on their own.
    forceCloseConnections: true,
    // Production accepts only the local Nginx hop, which overwrites forwarded identity.
    trustProxy: config.mode === "production" ? ["127.0.0.1"] : false,
  });
  app.decorate("database", db);
  let stopping = false;
  app.addHook("preClose", async () => {
    stopping = true;
  });
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
  // Optional posters from TMDB, a few films at a time, never two runs at once.
  if (config.tmdbToken) {
    const token = config.tmdbToken;
    let running = false,
      refused = false;
    const lookup = async () => {
      if (running || refused) return;
      running = true;
      try {
        const outcome = await lookupArtwork(db, config.dataDir, token, {
          fetcher: options.artworkFetch,
        });
        if (outcome.refused) {
          refused = true;
          console.error(
            "TMDB refused the configured token; artwork lookup stopped.",
          );
        }
      } catch (error) {
        console.error("Artwork lookup failed.", startupReason(error));
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => void lookup(), 30000);
    const every = setInterval(() => void lookup(), 600000);
    first.unref();
    every.unref();
    app.addHook("onClose", async () => {
      clearTimeout(first);
      clearInterval(every);
    });
    app.decorate("lookupArtwork", lookup);
  }
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  // Only a plainly written path is answered. The proxy in front chooses its
  // rule (and whether to demand the origin key) from the path with "..", "//"
  // and "%2F" resolved, then passes the path on as it was written, and this
  // router resolves none of those. Each such difference is a way round a
  // layer: "/api/movies/..%2f..%2fmedia%2fx/pictures" entered by the proxy's
  // open media rule and arrived here as an API route.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    if (
      /%(2f|5c|2e|25)/i.test(path) ||
      path.includes("\\") ||
      path.includes("//") ||
      /(^|\/)\.{1,2}(\/|$)/.test(path)
    )
      return reply.code(404).send({ error: "not_found" });
  });
  // Routes are declared after the limiter: it only counts those it sees added.
  // The credit TMDB asks for, shown wherever its pictures may appear.
  app.get("/api/artwork-credits", async () =>
    config.tmdbToken ? { tmdb: TMDB_NOTICE } : {},
  );
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
      .header("Referrer-Policy", "no-referrer");
    // Nothing is cached unless its route says it may be (only artwork does).
    if (!reply.getHeader("Cache-Control"))
      reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    // A fault of the server's own must leave a trace, or it cannot be found.
    // Only the matched route pattern and the error's class and code are
    // written: never the address (tickets and OAuth codes travel in it), a
    // header, or a message, which can quote the data that failed to parse.
    // Not while stopping: requests cut off by the stop fail by design.
    if (!(status >= 400 && status < 500) && !stopping) {
      const word = (value: unknown) =>
        typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value)
          ? value
          : "";
      console.error(
        "Request failed.",
        request.method,
        request.routeOptions.url ?? "unmatched",
        word(error instanceof Error ? error.name : "") || "unknown",
        word((error as { code?: unknown }).code),
      );
    }
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
  const bookSource = new DriveSourceReader(
    app.getDecorator<() => Promise<string>>("getDriveAccessToken"),
    (id, fresh) => library.verifyReading(id, fresh),
    options.sourceFetch,
    undefined,
    BOOK_BLOCK_PARTS,
    BOOK_DRIVE_IN_FLIGHT,
  );
  const cache = new BlockCache(
    db,
    join(config.dataDir, "source-cache"),
    {
      maxBytes: 20n * 1024n ** 3n,
      minFreeBytes: BigInt(config.minFreeBytes),
      readAhead: 2,
    },
    (ref, start, end, signal) =>
      (ref.reading ? bookSource : source).block(ref, start, end, signal),
  );
  await cache.init();
  registerSessions(app, db, config, library, cache);
  registerCatalogue(app, db, config.dataDir);
  registerReading(app, db, library, cache, Boolean(config.workerKey));
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
    app.post<{ Params: { id: string; generation: string; index: string } }>(
      "/_worker/reading/:id/:generation/:index",
      { preHandler: workerAuth, config: unlimited },
      (request, reply) => warmReadingBlock(request, reply, library, cache),
    );
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
        const gone = sourceGone(error);
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
