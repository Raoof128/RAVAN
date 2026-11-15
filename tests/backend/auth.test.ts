import { TOTP, Secret } from "otpauth";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { TokenStore } from "../../apps/api/src/auth/token-store.js";
import { openDatabase } from "../../packages/db/src/open.js";
import type { OAuthProvider } from "../../apps/api/src/auth/oauth.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function directory() {
  const p = await mkdtemp(join(tmpdir(), "mov-auth-"));
  cleanup.push(() => rm(p, { recursive: true, force: true }));
  return p;
}
async function setup(subject = "owner") {
  const provider: OAuthProvider = {
    authorizationUrl: ({ state, nonce }) =>
      `https://accounts.google.com/auth?state=${state}&nonce=${nonce}`,
    exchange: async (_code, _verifier, nonce) => ({
      subject,
      nonce,
      refreshToken: "private-refresh",
      accessToken: "private-access",
      expiresAt: Date.now() + 3600000,
    }),
    refresh: async () => ({
      accessToken: "renewed",
      expiresAt: Date.now() + 3600000,
    }),
  };
  const config = parseConfig({
    mode: "test",
    dataDir: await directory(),
    minFreeBytes: 0,
    clientId: "client",
    clientSecret: "secret",
    ownerSubject: "owner",
    encryptionKey: "ab".repeat(32),
    origin: "http://localhost:4310",
  });
  const app = await buildApp(config, { oauthProvider: provider });
  cleanup.push(() => app.close());
  return { app, provider };
}
async function login(
  app: Awaited<ReturnType<typeof setup>>["app"],
  complete = true,
) {
  const start = await app.inject("/auth/google/start");
  const location = new URL(start.headers.location as string);
  const cookie = start.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const result = await app.inject({
    url: `/auth/google/callback?code=one&state=${location.searchParams.get("state")}`,
    headers: { cookie },
  });
  let finalCookie = result.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (complete && result.statusCode === 302) {
    const state = (
      await app.inject({
        url: "/api/session",
        headers: { cookie: finalCookie },
      })
    ).json();
    const headers = {
      cookie: finalCookie,
      origin: "http://localhost:4310",
      "x-csrf-token": state.csrfToken,
    };
    const enrollment = (
      await app.inject({ method: "POST", url: "/auth/mfa/enroll", headers })
    ).json();
    const code = new TOTP({
      secret: Secret.fromBase32(enrollment.secret),
    }).generate();
    const verified = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      headers,
      payload: { code },
    });
    expect(verified.statusCode).toBe(200);
    finalCookie = verified.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  return {
    result,
    callbackCookie: cookie,
    state: location.searchParams.get("state")!,
    cookie: finalCookie,
  };
}
it("logs in only the pinned owner without exposing google tokens", async () => {
  const { app } = await setup();
  const { result, cookie } = await login(app);
  expect(result.statusCode).toBe(302);
  const session = await app.inject({
    url: "/api/session",
    headers: { cookie },
  });
  expect(session.json().authenticated).toBe(true);
  expect(session.json().csrfToken).toBeTruthy();
  expect(JSON.stringify(session.json())).not.toMatch(
    /private-access|private-refresh|secret/,
  );
});
it("rejects unapproved owner", async () => {
  const { app } = await setup("attacker");
  expect((await login(app)).result.statusCode).toBe(403);
});
it("rejects bad state and replayed callbacks", async () => {
  const { app } = await setup();
  expect(
    (await app.inject("/auth/google/callback?code=bad&state=bad")).statusCode,
  ).toBe(400);
  const { state, callbackCookie } = await login(app);
  expect(
    (
      await app.inject({
        url: `/auth/google/callback?code=one&state=${state}`,
        headers: { cookie: callbackCookie },
      })
    ).statusCode,
  ).toBe(400);
});
it("rejects missing csrf and revokes logout sessions", async () => {
  const { app } = await setup();
  const { cookie } = await login(app);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/logout",
        headers: { cookie, origin: "http://localhost:4310" },
      })
    ).statusCode,
  ).toBe(403);
  const { csrfToken } = (
    await app.inject({ url: "/api/session", headers: { cookie } })
  ).json();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/logout",
        headers: {
          cookie,
          origin: "https://evil.test",
          "x-csrf-token": csrfToken,
        },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/logout",
        headers: {
          cookie,
          origin: "http://localhost:4310",
          "x-csrf-token": csrfToken,
        },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await app.inject({ url: "/api/session", headers: { cookie } })).json()
      .authenticated,
  ).toBe(false);
});
it("encrypts at rest and serializes eight simultaneous refreshes", async () => {
  const db = openDatabase(join(await directory(), "auth.sqlite"));
  cleanup.push(async () => db.close());
  const refresh = vi.fn(async () => ({
    accessToken: "access",
    expiresAt: Date.now() + 3600000,
  }));
  const store = new TokenStore(
    db,
    Buffer.from("ab".repeat(32), "hex"),
    refresh,
  );
  store.saveRefreshToken("refresh-secret");
  expect(
    JSON.stringify(db.prepare("SELECT * FROM credentials").all()),
  ).not.toContain("refresh-secret");
  expect(
    await Promise.all(Array.from({ length: 8 }, () => store.getAccessToken())),
  ).toEqual(Array(8).fill("access"));
  expect(refresh).toHaveBeenCalledTimes(1);
});
it("rejects mismatched nonce", async () => {
  const { app, provider } = await setup();
  provider.exchange = async () => ({
    subject: "owner",
    nonce: "wrong",
    refreshToken: "x",
    accessToken: "x",
    expiresAt: Date.now() + 10000,
  });
  expect((await login(app)).result.statusCode).toBe(403);
});

it.each(["issuer", "audience"])(
  "rejects a signed identity with the wrong %s",
  async (field) => {
    const { generateKeyPairSync, createSign } = await import("node:crypto");
    const { OAuth2Client } = await import("google-auth-library");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const encode = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss: field === "issuer" ? "https://evil.test" : "https://accounts.google.com", aud: field === "audience" ? "another-client" : "client", sub: "owner", iat: now, exp: now + 3600, nonce: "nonce" })}`;
    const signature = createSign("RSA-SHA256")
      .update(body)
      .sign(privateKey, "base64url");
    const verifier = new OAuth2Client();
    await expect(
      verifier.verifySignedJwtWithCertsAsync(
        `${body}.${signature}`,
        { test: publicKey.export({ type: "spki", format: "pem" }).toString() },
        "client",
        ["accounts.google.com", "https://accounts.google.com"],
      ),
    ).rejects.toThrow();
  },
);

it("retains the refresh credential across restart when Google omits a replacement", async () => {
  const path = join(await directory(), "restart.sqlite");
  let db = openDatabase(path);
  const store = new TokenStore(
    db,
    Buffer.from("ab".repeat(32), "hex"),
    async () => ({ accessToken: "new", expiresAt: 0 }),
  );
  store.saveRefreshToken("original");
  await store.getAccessToken();
  db.close();
  db = openDatabase(path);
  cleanup.push(async () => db.close());
  const refresh = vi.fn(async () => ({
    accessToken: "after-restart",
    expiresAt: Date.now() + 3600000,
  }));
  expect(
    await new TokenStore(
      db,
      Buffer.from("ab".repeat(32), "hex"),
      refresh,
    ).getAccessToken(),
  ).toBe("after-restart");
  expect(refresh).toHaveBeenCalledWith("original");
});

it("Google alone cannot access library, pairing approval, devices or MFA without CSRF", async () => {
  const { app } = await setup();
  const { cookie, result } = await login(app, false);
  expect(result.cookies.find((c) => c.name === "mov_session")?.value).toBe("");
  const state = (
    await app.inject({ url: "/api/session", headers: { cookie } })
  ).json();
  expect(state).toMatchObject({ authenticated: false, mfa: "enroll" });
  for (const url of ["/api/movies", "/api/devices", "/api/library"])
    expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(
      401,
    );
  for (const url of [
    "/auth/mfa/enroll",
    "/auth/mfa/verify",
    "/auth/mfa/cancel",
  ]) {
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie },
          payload: { code: "123456" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: {
            cookie,
            origin: "https://evil.example",
            "x-csrf-token": state.csrfToken,
          },
          payload: { code: "123456" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url, payload: { code: "123456" } }))
        .statusCode,
    ).toBe(401);
  }
  const enrollment = await app.inject({
    method: "POST",
    url: "/auth/mfa/enroll",
    headers: {
      cookie,
      origin: "http://localhost:4310",
      "x-csrf-token": state.csrfToken,
    },
  });
  expect(enrollment.statusCode).toBe(200);
  expect(enrollment.headers["cache-control"]).toBe("no-store");
});

it("concurrent verification issues only one session and cancellation destroys the challenge", async () => {
  const { app } = await setup();
  const { cookie } = await login(app, false);
  const state = (
    await app.inject({ url: "/api/session", headers: { cookie } })
  ).json();
  const headers = {
    cookie,
    origin: "http://localhost:4310",
    "x-csrf-token": state.csrfToken,
  };
  const enrollment = (
    await app.inject({ method: "POST", url: "/auth/mfa/enroll", headers })
  ).json();
  const payload = {
    code: new TOTP({ secret: Secret.fromBase32(enrollment.secret) }).generate(),
  };
  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/auth/mfa/verify", headers, payload }),
    app.inject({ method: "POST", url: "/auth/mfa/verify", headers, payload }),
  ]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  const next = await login(app, false);
  const session = (
    await app.inject({ url: "/api/session", headers: { cookie: next.cookie } })
  ).json();
  const nextHeaders = {
    cookie: next.cookie,
    origin: "http://localhost:4310",
    "x-csrf-token": session.csrfToken,
  };
  expect(session.mfa).toBe("verify");
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/auth/mfa/cancel",
        headers: nextHeaders,
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/auth/mfa/verify",
        headers: nextHeaders,
        payload,
      })
    ).statusCode,
  ).toBe(401);
});
