import { expect, it } from "vitest";
import type { OAuthProvider } from "../../apps/api/src/auth/oauth.js";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const provider: OAuthProvider = {
  authorizationUrl: ({ state }) =>
    `https://accounts.google.com/auth?state=${state}`,
  exchange: async (_code, _verifier, nonce) => ({
    subject: "owner",
    nonce,
    accessToken: "private-access",
    refreshToken: "private-refresh",
    expiresAt: Date.now() + 3600000,
  }),
  refresh: async () => ({ accessToken: "x", expiresAt: Date.now() + 3600000 }),
};
async function app() {
  const dataDir = await mkdtemp(join(tmpdir(), "mov-oauth-"));
  const instance = await buildApp(
    parseConfig({
      mode: "test",
      dataDir,
      minFreeBytes: 0,
      clientId: "client",
      clientSecret: "secret",
      ownerSubject: "owner",
      encryptionKey: "ab".repeat(32),
      origin: "http://localhost:4310",
    }),
    { oauthProvider: provider },
  );
  return {
    instance,
    async close() {
      await instance.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

it("anonymous sign-in attempts cannot exhaust the pending state and lock the owner out", async () => {
  const h = await app();
  try {
    // 100 abandoned attempts from distinct addresses stay inside every per-address limit.
    for (let i = 0; i < 100; i++)
      expect(
        (
          await h.instance.inject({
            url: "/auth/google/start",
            remoteAddress: `198.51.100.${i}`,
          })
        ).statusCode,
      ).toBe(302);
    const start = await h.instance.inject({
      url: "/auth/google/start",
      remoteAddress: "203.0.113.9",
    });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get(
      "state",
    );
    const callback = await h.instance.inject({
      url: `/auth/google/callback?code=code&state=${state}`,
      remoteAddress: "203.0.113.9",
      headers: {
        cookie: start.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      },
    });
    expect(callback.statusCode).toBe(302);
  } finally {
    await h.close();
  }
});

it("still binds a callback to the browser that started it after older attempts are evicted", async () => {
  const h = await app();
  try {
    const first = await h.instance.inject({
      url: "/auth/google/start",
      remoteAddress: "203.0.113.1",
    });
    const firstState = new URL(
      first.headers.location as string,
    ).searchParams.get("state");
    for (let i = 0; i < 100; i++)
      await h.instance.inject({
        url: "/auth/google/start",
        remoteAddress: `198.51.100.${i}`,
      });
    // The evicted attempt fails closed instead of being accepted without its state.
    expect(
      (
        await h.instance.inject({
          url: `/auth/google/callback?code=code&state=${firstState}`,
          headers: {
            cookie: first.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
          },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await h.close();
  }
});
