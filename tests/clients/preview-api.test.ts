import { afterEach, expect, it, vi } from "vitest";
import { previewApi } from "../../apps/web/src/preview.js";

afterEach(() => vi.unstubAllGlobals());

it("never lets the public demo reach the real API, whatever it is asked", async () => {
  // The demo is served from the cinema's own address, so a request it made
  // would carry the owner's cookie. Some methods were left unstubbed.
  const network = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", network);
  const api = previewApi() as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const [name, method] of Object.entries(api)) {
    if (typeof method !== "function") continue;
    try {
      await method(
        name === "artwork" ? `/api/artwork/${"a".repeat(32)}` : "sample-0",
        {},
        0,
      );
    } catch {
      // Refusing is fine; reaching the network is not.
    }
  }
  expect(network).not.toHaveBeenCalled();
});
