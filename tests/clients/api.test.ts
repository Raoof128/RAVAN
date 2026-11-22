import { afterEach, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../../packages/client/src/api.js";
afterEach(() => vi.unstubAllGlobals());

it("reports a non-JSON gateway error by its status instead of a parse failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    ),
  );
  const failure = await createApiClient("")
    .listMovies()
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ status: 502, code: "request_failed" });
});

it("keeps the server's error code and the accepted playback statuses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).endsWith("/api/playback")
        ? Response.json({ kind: "conflict", sessionId: "s" }, { status: 409 })
        : Response.json({ error: "rate_limited" }, { status: 429 }),
    ),
  );
  const api = createApiClient("");
  expect(await api.playback("m", "web", 0)).toEqual({
    kind: "conflict",
    sessionId: "s",
  });
  await expect(api.listMovies()).rejects.toMatchObject({
    status: 429,
    code: "rate_limited",
  });
});

it("saves reading progress without keepalive where the browser refuses it (Chromium 79)", async () => {
  // Chromium before 81 rejects a keepalive request that needs a preflight
  // (JSON body, CSRF header) before sending it, with a TypeError.
  const calls: Array<boolean | undefined> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.keepalive);
      if (init.keepalive) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 204 });
    }),
  );
  const api = createApiClient("");
  const item = {
    id: "b",
    title: "B",
    name: "B.epub",
    format: "epub" as const,
    generation: "a".repeat(64),
    sizeBytes: "1",
    position: { section: 0, fraction: 0 },
    preparation: { state: "on-demand" as const, percent: 0 },
  };
  await api.saveReading(item, { section: 1, fraction: 0.5 });
  await api.saveReading(item, { section: 2, fraction: 0 });
  // Tried once with keepalive, then plain from then on.
  expect(calls).toEqual([true, false, false]);
});

it("keeps keepalive where the browser accepts it", async () => {
  const calls: Array<boolean | undefined> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.keepalive);
      return new Response(null, { status: 204 });
    }),
  );
  const api = createApiClient("");
  const item = {
    id: "b",
    title: "B",
    name: "B.epub",
    format: "epub" as const,
    generation: "a".repeat(64),
    sizeBytes: "1",
    position: { section: 0, fraction: 0 },
    preparation: { state: "on-demand" as const, percent: 0 },
  };
  await api.saveReading(item, { section: 1, fraction: 0 });
  await api.saveReading(item, { section: 2, fraction: 0 });
  expect(calls).toEqual([true, true]);
});

it("keeps keepalive after a save that failed on the network", async () => {
  const calls: Array<boolean | undefined> = [];
  let offline = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.keepalive);
      if (offline) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 204 });
    }),
  );
  const api = createApiClient("");
  const item = {
    id: "b",
    title: "B",
    name: "B.epub",
    format: "epub" as const,
    generation: "a".repeat(64),
    sizeBytes: "1",
    position: { section: 0, fraction: 0 },
    preparation: { state: "on-demand" as const, percent: 0 },
  };
  await expect(
    api.saveReading(item, { section: 1, fraction: 0 }),
  ).rejects.toThrow(TypeError);
  offline = false;
  await api.saveReading(item, { section: 1, fraction: 0 });
  expect(calls).toEqual([true, false, true]);
});
