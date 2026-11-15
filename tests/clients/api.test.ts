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
