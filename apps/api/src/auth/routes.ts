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
  const pending = new Map<
    string,
    { nonce: string; verifier: string; browserHash: string; expires: number }
  >();
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
      for (const [key, value] of pending)
        if (value.expires < Date.now()) pending.delete(key);
      if (pending.size >= 100)
        return reply.code(429).send({ error: "try_later" });
      const state = secret(),
        nonce = secret(),
        verifier = secret(),
        browser = secret();
      pending.set(hash(state), {
        nonce,
        verifier,
        browserHash: hash(browser),
        expires: Date.now() + 600000,
      });
      reply.setCookie("mov_oauth", browser, { ...cookieOptions, maxAge: 600 });
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
      entry = pending.get(key);
    if (
      !entry ||
      entry.expires < Date.now() ||
      !equal(entry.browserHash, hash(request.cookies.mov_oauth ?? ""))
    )
      return reply.code(400).send({ error: "invalid_oauth_state" });
    pending.delete(key);
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
    if (device) return { authenticated: true, configured, deviceId: device.id };
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
  app.addHook("preHandler", async (request, reply) => {
    if (
      !request.url.startsWith("/api/") ||
      request.routeOptions.url === "/api/session"
    )
      return;
    const route = request.routeOptions.url ?? "";
    if (
      [" /api/pairing", "/api/pairing/poll"]
        .map((s) => s.trim())
        .includes(route)
    )
      return;
    const device = findDevice(db, request);
    if (device) {
      const allowed =
        (request.method === "GET" &&
          ["/api/movies", "/api/movies/:id", "/api/preferences"].includes(
            route,
          )) ||
        [
          "/api/playback",
          "/api/playback/:id/heartbeat",
          "/api/playback/:id",
          "/api/progress",
          "/api/pairing/ack",
        ].includes(route);
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
