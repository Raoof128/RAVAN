import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
it("trusts forwarding identity only from the production loopback proxy", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ravan-proxy-"));
  const app = await buildApp(
    parseConfig({
      mode: "production",
      dataDir,
      origin: "https://ravan.example",
      clientId: "test",
      clientSecret: "test",
      ownerSubject: "test",
      encryptionKey: "a".repeat(64),
    }),
  );
  try {
    app.get("/test-ip", async (req) => ({ ip: req.ip }));
    expect(
      (
        await app.inject({
          url: "/test-ip",
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "203.0.113.7" },
        })
      ).json(),
    ).toEqual({ ip: "203.0.113.7" });
    expect(
      (
        await app.inject({
          url: "/test-ip",
          remoteAddress: "192.0.2.1",
          headers: { "x-forwarded-for": "203.0.113.7" },
        })
      ).json(),
    ).toEqual({ ip: "192.0.2.1" });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
