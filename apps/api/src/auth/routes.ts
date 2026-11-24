import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../../../packages/db/src/open.js";
import type { AppConfig } from "../config.js";
import { googleProvider, type OAuthProvider } from "./oauth.js";
import { equal, findSession, hash, secret } from "./sessions.js";
import { validCsrf } from "./csrf.js";
import { TokenStore } from "./token-store.js";
import { z } from "zod";
import { MfaService } from "./mfa.js";
import { registerMfaRoutes } from "./mfa-routes.js";
import { findDevice } from "../sessions/devices.js";
import {
  findReaderSession,
  issueReaderSession,
  readerCookie,
  READER_COOKIE,
  READER_SESSION_SECONDS,
} from "./reader-sessions.js";

// Reachable without an owner session: session discovery and the TV's own pairing
// handshake, which is bound to a poll secret and approved separately by the owner.
const publicApiRoutes = new Set([
  "/api/session",
  "/api/pairing",
  "/api/pairing/poll",
]);
const deviceReadRoutes = new Set([
  "/api/movies",
  "/api/movies/:id",
  "/api/preferences",
  "/api/continue-watching",
  "/api/preparations/:id",
  "/api/artwork/:id",
]);
const deviceRoutes = new Set([
  "/api/playback",
  "/api/playback/:id/heartbeat",
  "/api/playback/:id",
  "/api/progress",
  "/api/pairing/ack",
  "/api/pairing/forget",
]);
const readerReadRoutes = new Set([
  "/api/reading",
  "/api/reading/:id/content",
  "/api/reading/:id/preparation",
  "/api/artwork/:id",
]);

export function registerAuth(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  injected?: OAuthProvider,
) {
  const configured = Boolean(
    config.clientId &&
    config.clientSecret &&
    config.ownerSubject &&
    config.encryptionKey,
  );
  const provider = injected ?? googleProvider(config);
  const store = configured
    ? new TokenStore(db, Buffer.from(config.encryptionKey!, "hex"), (token) =>
        provider.refresh(token),
      )
    : undefined;
  const mfa = configured
    ? new MfaService(db, Buffer.from(config.encryptionKey!, "hex"))
    : undefined;
  registerMfaRoutes(app, mfa, config.origin);
  // A sign-in attempt lives in the browser that started it, sealed with a key
  // only this server holds, not in a table here. A table has to be bounded,
  // and whatever bounds it lets strangers push the owner's attempt out: a
  // hundred anonymous requests from ten networks used to end any sign-in.
  const sealKey = configured
    ? Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from(config.encryptionKey!, "hex"),
          Buffer.alloc(0),
          "ravan:oauth:v1",
          32,
        ),
      )
    : undefined;
  const sealed = z.strictObject({
    state: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().min(1).max(128),
    verifier: z.string().min(1).max(128),
    expires: z.number().int().positive(),
  });
  const aad = Buffer.from("ravan:oauth:v1");
  const seal = (attempt: z.infer<typeof sealed>) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", sealKey!, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(attempt), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  };
  const unseal = (cookie: string | undefined) => {
    if (!sealKey || !cookie || cookie.length > 2048) return;
    try {
      const bytes = Buffer.from(cookie, "base64url");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        sealKey,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(12, 28));
      const parsed = sealed.safeParse(
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return;
    }
  };
  // Answers already acted on, so one cannot be sent twice. Only an answer
  // carrying a cookie this server sealed is recorded, so strangers cannot fill
  // it; losing the oldest entry costs nothing, since Google refuses a code twice.
  const answered = new Map<string, number>();
  const secure = config.origin.startsWith("https://");
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  app.get(
    "/auth/google/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      if (!configured)
        return reply.code(503).send({ error: "google_not_configured" });
      const state = secret(),
        nonce = secret(),
        verifier = secret();
      reply.setCookie(
        "mov_oauth",
        seal({
          state: hash(state),
          nonce,
          verifier,
          expires: Date.now() + 600000,
        }),
        { ...cookieOptions, maxAge: 600 },
      );
      const challenge = Buffer.from(hash(verifier), "hex").toString(
        "base64url",
      );
      return reply.redirect(
        provider.authorizationUrl({ state, nonce, challenge }),
      );
    },
  );
  app.get("/auth/google/callback", async (request, reply) => {
    const query = z
      .object({
        code: z.string().min(1).max(4096),
        state: z.string().min(1).max(128),
      })
      .safeParse(request.query);
    if (!query.success || !store)
      return reply.code(400).send({ error: "invalid_oauth_callback" });
    const key = hash(query.data.state),
      entry = unseal(request.cookies.mov_oauth),
      now = Date.now();
    if (
      !entry ||
      entry.expires < now ||
      !equal(entry.state, key) ||
      (answered.get(key) ?? 0) > now
    )
      return reply.code(400).send({ error: "invalid_oauth_state" });
    for (const [used, expires] of answered)
      if (expires <= now) answered.delete(used);
    while (answered.size >= 1000)
      answered.delete(answered.keys().next().value as string);
    answered.set(key, entry.expires);
    reply.clearCookie("mov_oauth", { path: "/" });
    try {
      const grant = await provider.exchange(
        query.data.code,
        entry.verifier,
        entry.nonce,
      );
      if (
        grant.subject !== config.ownerSubject ||
        !equal(grant.nonce, entry.nonce)
      )
        return reply.code(403).send({ error: "owner_required" });
      store.acceptGrant(grant);
      const challenge = mfa!.createChallenge(grant.subject);
      const prior = findSession(db, request);
      if (prior) {
        db.prepare("DELETE FROM web_sessions WHERE token_hash=?").run(
          prior.token_hash,
        );
        db.prepare(
          "UPDATE playback_sessions SET revoked_at=? WHERE web_session_hash=?",
        ).run(Date.now(), prior.token_hash);
      }
      reply.clearCookie("mov_session", { path: "/" });
      db.prepare("INSERT OR IGNORE INTO owner VALUES (?,?)").run(
        grant.subject,
        Date.now(),
      );
      reply.setCookie("mov_mfa", challenge.token, {
        ...cookieOptions,
        expires: new Date(challenge.expires),
      });
      return reply.redirect("/");
    } catch {
      return reply.code(403).send({ error: "authorization_failed" });
    }
  });
  app.get("/api/session", async (request) => {
    const device = findDevice(db, request);
    if (device)
      return {
        authenticated: true,
        configured,
        deviceId: device.id,
        permissions: [
          ...(device.watchlist_write ? ["watchlist:write"] : []),
          ...(device.reading ? ["reading:read"] : []),
        ],
      };
    if (readerCookie(request) !== undefined) {
      const reader = findReaderSession(db, request);
      return reader
        ? {
            authenticated: true,
            configured,
            readerOnly: true,
            csrfToken: reader.csrf,
          }
        : { authenticated: false, configured };
    }
    const session = findSession(db, request);
    if (session)
      return { authenticated: true, configured, csrfToken: session.csrf };
    const challenge = mfa?.challenge(request.cookies.mov_mfa);
    return {
      authenticated: false,
      configured,
      ...(challenge
        ? {
            mfa: challenge.mode === "verify" ? "verify" : "enroll",
            csrfToken: challenge.csrf,
            challengeExpiresAt: challenge.expires_at,
          }
        : {}),
    };
  });
  // Authorize by the matched route pattern, never the raw request path. The router
  // percent-decodes before matching, so "/%61pi/movies" reaches the "/api/movies"
  // handler while its raw URL does not start with "/api/".
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    if (!route.startsWith("/api/") || route === "/api/session") return;
    const device = findDevice(db, request, route === "/api/pairing/ack");
    if (!device && readerCookie(request) !== undefined) {
      const reader = findReaderSession(db, request);
      if (!reader)
        return reply.code(401).send({ error: "authentication_required" });
      if (
        ["GET", "HEAD"].includes(request.method) &&
        readerReadRoutes.has(route)
      )
        return;
      if (request.method === "PUT" && route === "/api/reading/:id/progress") {
        if (validCsrf(request, reader, config.origin)) return;
        return reply.code(403).send({ error: "csrf_failed" });
      }
      return reply.code(403).send({ error: "reader_scope_required" });
    }
    if (
      (request.method === "GET" && route === "/api/capabilities") ||
      publicApiRoutes.has(route)
    )
      return;
    if (device) {
      const allowed =
        (request.method === "GET" && deviceReadRoutes.has(route)) ||
        (request.method === "POST" &&
          route === "/api/reading/session" &&
          device.reading === 1) ||
        (request.method === "DELETE" && route === "/api/devices/self") ||
        (request.method === "PUT" &&
          route === "/api/watchlist/:id" &&
          device.watchlist_write === 1) ||
        deviceRoutes.has(route);
      if (allowed) return;
      return reply.code(403).send({ error: "owner_required" });
    }
    const session = findSession(db, request);
    if (!session)
      return reply.code(401).send({ error: "authentication_required" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !validCsrf(request, session, config.origin)
    )
      return reply.code(403).send({ error: "csrf_failed" });
  });
  app.post("/api/reading/session", async (request, reply) => {
    const device = findDevice(db, request);
    if (!device?.reading || !secure)
      return reply.code(403).send({ error: "reading_grant_required" });
    const token = issueReaderSession(db, device.id);
    if (!token)
      return reply.code(403).send({ error: "reading_grant_required" });
    return reply
      .setCookie(READER_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/api",
        maxAge: READER_SESSION_SECONDS,
      })
      .header("Cache-Control", "no-store")
      .code(204)
      .send();
  });
  app.post("/api/logout", async (request, reply) => {
    const session = findSession(db, request);
    if (session)
      db.transaction(() => {
        db.prepare("DELETE FROM web_sessions WHERE token_hash=?").run(
          session.token_hash,
        );
        db.prepare(
          "UPDATE playback_sessions SET revoked_at=? WHERE web_session_hash=?",
        ).run(Date.now(), session.token_hash);
      })();
    reply.clearCookie("mov_session", { path: "/" });
    return reply.code(204).send();
  });
  app.decorate("getDriveAccessToken", () => {
    if (!store) throw new Error("Drive not configured");
    return store.getAccessToken();
  });
}
