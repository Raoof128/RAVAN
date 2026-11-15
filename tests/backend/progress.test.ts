import { expect, it } from "vitest";
import { sessionFixture } from "../fixtures/session-harness.js";
it("rejects stale sequence and epoch while accepting intentional rewinds", async () => {
  const { service, db } = await sessionFixture();
  const result = await service.create("m", "web", 0, { webHash: "owner" });
  if (result.kind !== "ready") throw new Error("not ready");
  const event = {
    sessionId: result.session.id,
    epoch: result.session.epoch,
    sequence: 1,
    positionMs: 10000,
    ended: false,
  };
  expect(service.recordProgress(event, { webHash: "owner" })).toBe("accepted");
  expect(
    service.recordProgress(
      { ...event, positionMs: 20000 },
      { webHash: "owner" },
    ),
  ).toBe("stale");
  expect(
    service.recordProgress(
      { ...event, sequence: 2, positionMs: 2000 },
      { webHash: "owner" },
    ),
  ).toBe("accepted");
  expect(
    (
      db
        .prepare("SELECT position_ms FROM progress WHERE movie_id='m'")
        .get() as { position_ms: number }
    ).position_ms,
  ).toBe(2000);
  const newer = await service.create(
    "m",
    "web",
    0,
    { webHash: "owner" },
    result.session.id,
  );
  expect(newer.kind).toBe("ready");
  expect(
    service.recordProgress({ ...event, sequence: 3 }, { webHash: "owner" }),
  ).toBe("stale");
});
