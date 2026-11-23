import { afterEach, expect, it, vi } from "vitest";
import worker from "../../apps/edge/src/index.js";
const env = {
  RELEASE: "test",
  PRIVATE_ORIGIN: "https://media.example.com",
  PRIVATE_ORIGIN_TOKEN: "a".repeat(64),
  PUBLIC_ORIGIN: "https://cinema.example.com",
};
afterEach(() => vi.unstubAllGlobals());
it("proxies authenticated API with a server key, preserves cookies and never follows OAuth redirects", async () => {
  const fetcher = vi.fn(async (req: Request) => {
    expect(req.url).toBe(env.PRIVATE_ORIGIN + "/auth/google/start");
    expect(req.headers.get("x-ravan-origin-key")).toBe(
      env.PRIVATE_ORIGIN_TOKEN,
    );
    expect(req.headers.get("cookie")).toBe("mov_session=browser");
    expect(req.redirect).toBe("manual");
    return new Response(null, {
      status: 302,
      headers: {
        location: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
        "set-cookie": "mov_oauth=test; HttpOnly; Secure; SameSite=Lax; Path=/",
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(
    new Request(env.PUBLIC_ORIGIN + "/auth/google/start", {
      headers: {
        cookie: "mov_session=browser",
        "x-ravan-origin-key": "forged",
      },
    }),
    env,
  );
  expect(result.status).toBe(302);
  expect(result.headers.get("set-cookie")).toContain("HttpOnly");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("redirects media to a fixed direct origin without fetching video bytes", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(
    new Request(env.PUBLIC_ORIGIN + "/media/s/ticket/raw", {
      headers: { Range: "bytes=0-10" },
    }),
    env,
  );
  expect(result.status).toBe(307);
  expect(result.headers.get("location")).toBe(
    env.PRIVATE_ORIGIN + "/media/s/ticket/raw",
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (
      await worker.fetch(
        new Request(env.PUBLIC_ORIGIN + "/media/s/ticket/raw", {
          method: "POST",
        }),
        env,
      )
    ).status,
  ).toBe(405);
});
it("refuses alternate origin mutations and canonicalizes alternate reads", async () => {
  expect(
    (
      await worker.fetch(
        new Request("https://ravan.raoof-r12.workers.dev/api/movies"),
        env,
      )
    ).status,
  ).toBe(308);
  expect(
    (
      await worker.fetch(
        new Request("https://ravan.raoof-r12.workers.dev/api/library", {
          method: "POST",
        }),
        env,
      )
    ).status,
  ).toBe(403);
});
it("fails closed on upstream errors and blocks worker paths without forwarding", async () => {
  const fetcher = vi.fn(async () => {
    throw Error("private infrastructure detail");
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(
    new Request(env.PUBLIC_ORIGIN + "/api/session"),
    env,
  );
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain("private infrastructure");
  fetcher.mockClear();
  expect(
    (
      await worker.fetch(
        new Request(env.PUBLIC_ORIGIN + "/_worker/source/file"),
        env,
      )
    ).status,
  ).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
});
it("preserves exact CSRF Origin, mutation body and response no-store headers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      expect(req.headers.get("origin")).toBe(env.PUBLIC_ORIGIN);
      expect(req.headers.get("x-csrf-token")).toBe("csrf");
      expect(await req.json()).toEqual({ code: "123456" });
      return Response.json({ authenticated: true });
    }),
  );
  const result = await worker.fetch(
    new Request(env.PUBLIC_ORIGIN + "/auth/mfa/verify", {
      method: "POST",
      headers: {
        Origin: env.PUBLIC_ORIGIN,
        "X-CSRF-Token": "csrf",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    }),
    env,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
});
it("overwrites client forwarding identity with the Cloudflare connection address", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      expect(req.headers.get("x-forwarded-for")).toBeNull();
      expect(req.headers.get("x-ravan-client-ip")).toBe("203.0.113.7");
      return Response.json({ ok: true });
    }),
  );
  expect(
    (
      await worker.fetch(
        new Request(env.PUBLIC_ORIGIN + "/api/session", {
          headers: {
            "CF-Connecting-IP": "203.0.113.7",
            "X-Forwarded-For": "1.1.1.1",
            "X-Ravan-Client-IP": "2.2.2.2",
          },
        }),
        env,
      )
    ).status,
  ).toBe(200);
});
it("publishes only deployment-configured media origins for native clients", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      protocolMajor: 1,
      mediaOrigins: ["https://unexpected.example"],
    }),
  );
  const response = await worker.fetch(
    new Request(env.PUBLIC_ORIGIN + "/api/capabilities"),
    env,
  );
  expect(await response.json()).toEqual({
    protocolMajor: 1,
    mediaOrigins: [env.PUBLIC_ORIGIN, env.PRIVATE_ORIGIN],
  });
  const frontend = await worker.fetch(
    new Request(env.PUBLIC_ORIGIN + "/api/capabilities"),
    { RELEASE: "frontend" },
  );
  expect(
    ((await frontend.json()) as { protocolMajor?: number }).protocolMajor,
  ).toBeUndefined();
});
