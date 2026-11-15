import { expect, it } from "vitest";
import { sessionFixture } from "../fixtures/session-harness.js";
it("requires explicit replacement and enforces ticket-to-asset binding", async () => {
  const { service } = await sessionFixture();
  const first = await service.create("m", "web", 0, { webHash: "owner" });
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") return;
  expect((await service.create("m", "web", 0, { webHash: "owner" })).kind).toBe(
    "conflict",
  );
  const ticket = first.session.mediaUrl.split("/")[3]!;
  expect(await service.authorizeMedia(ticket, "raw")).toEqual({
    fileId: "f",
    generation: "generation",
    sizeBytes: "10",
  });
  await expect(service.authorizeMedia(ticket, "other.ts")).rejects.toThrow();
  const second = await service.create(
    "m",
    "web",
    0,
    { webHash: "owner" },
    first.session.id,
  );
  expect(second.kind).toBe("ready");
  await expect(service.authorizeMedia(ticket, "raw")).rejects.toThrow();
});
it("expires inactive and unrenewed source leases even with cached data", async () => {
  const { service, advance, deny } = await sessionFixture();
  const result = await service.create("m", "web", 0, { webHash: "owner" });
  if (result.kind !== "ready") throw new Error("not ready");
  const ticket = result.session.mediaUrl.split("/")[3]!;
  advance(120001);
  await expect(service.authorizeMedia(ticket, "raw")).rejects.toThrow();
  const next = await service.create("m", "web", 0, { webHash: "owner" });
  if (next.kind !== "ready") throw new Error("not ready");
  deny();
  for (let i = 0; i < 8; i++) {
    advance(30000);
    await service.heartbeat(next.session.id, { webHash: "owner" });
  }
  advance(30000);
  await expect(
    service.heartbeat(next.session.id, { webHash: "owner" }),
  ).rejects.toThrow();
  advance(60000);
  await expect(
    service.authorizeMedia(next.session.mediaUrl.split("/")[3]!, "raw"),
  ).rejects.toThrow();
});
it("renews six-hour tickets and rejects another principal heartbeat", async () => {
  const { service, advance } = await sessionFixture();
  const result = await service.create("m", "web", 0, { webHash: "owner" });
  if (result.kind !== "ready") throw new Error("not ready");
  await expect(
    service.heartbeat(result.session.id, { webHash: "other" }),
  ).rejects.toThrow();
  let current = result.session;
  for (let i = 0; i < 721; i++) {
    advance(30000);
    current = await service.heartbeat(current.id, { webHash: "owner" });
  }
  expect(current.mediaUrl).not.toBe(result.session.mediaUrl);
  await expect(
    service.authorizeMedia(result.session.mediaUrl.split("/")[3]!, "raw"),
  ).rejects.toThrow();
});
it("blocks anonymous media, subtitle, manifest and artwork routes", async () => {
  const h = await sessionFixture();
  for (const path of [
    "/media/s/invalid/raw",
    "/media/s/invalid/index.m3u8",
    "/media/s/invalid/captions.vtt",
    "/api/artwork/private",
    "/api/source/f/raw",
  ])
    expect((await h.app.inject(path)).statusCode).toBeGreaterThanOrEqual(400);
});
