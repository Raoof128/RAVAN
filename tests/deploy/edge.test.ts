import { describe, it, expect } from "vitest";
import worker from "../../apps/edge/src/index.js";
const env = { RELEASE: "test-release" };
describe("unconfigured public edge", () => {
  it("never turns a demo query or forged credential into authentication", async () => {
    for (const suffix of ["", "?preview=1", "?demo=1"]) {
      const response = await worker.fetch(
        new Request("https://ravan.test/api/session" + suffix, {
          headers: {
            Authorization: "Bearer invented",
            Cookie: "session=invented",
          },
        }),
        env,
      );
      expect(await response.json()).toEqual({
        authenticated: false,
        configured: false,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
  it("closes auth and mutations without a backend", async () => {
    for (const [path, method] of [
      ["/auth/google/start", "GET"],
      ["/auth/mfa/enroll", "POST"],
      ["/auth/mfa/verify", "POST"],
      ["/auth/mfa/cancel", "POST"],
      ["/api/movies", "GET"],
      ["/api/library", "POST"],
      ["/api/session", "POST"],
      ["/api/session", "OPTIONS"],
    ]) {
      const response = await worker.fetch(
        new Request("https://ravan.test" + path, { method }),
        env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("does not expose media, worker source, or arbitrary paths", async () => {
    for (const path of [
      "/media/s/fake/raw",
      "/_worker/source",
      "/.env",
      "/missing.js",
    ]) {
      const response = await worker.fetch(
        new Request("https://ravan.test" + path),
        env,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
    }
  });
  it("identifies the frontend release and handles HEAD without a body", async () => {
    const response = await worker.fetch(
      new Request("https://ravan.test/version.json"),
      env,
    );
    expect(await response.json()).toEqual({
      product: "RAVAN",
      release: "test-release",
      deployment: "frontend",
      streaming: false,
    });
    const head = await worker.fetch(
      new Request("https://ravan.test/api/session", { method: "HEAD" }),
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
