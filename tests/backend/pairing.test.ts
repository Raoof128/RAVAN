import { expect, it } from "vitest";
import { createHarness } from "../fixtures/harness.js";
import { PairingService } from "../../apps/api/src/sessions/pairing.js";
it("binds polling to its secret, delivers idempotently and consumes acknowledgement", async () => {
  const h = await createHarness();
  try {
    let now = 10000;
    const pairing = new PairingService(h.db, Buffer.alloc(32, 1), () => now);
    const challenge = pairing.create("Living room");
    expect(challenge.code).toHaveLength(8);
    expect(() => pairing.poll(challenge.id, "wrong")).toThrow();
    expect(pairing.poll(challenge.id, challenge.pollSecret).state).toBe(
      "pending",
    );
    pairing.approve(challenge.code);
    expect(() => pairing.approve(challenge.code)).toThrow();
    now += 5000;
    const first = pairing.poll(challenge.id, challenge.pollSecret);
    expect(first.state).toBe("approved");
    if (first.state !== "approved") return;
    now += 5000;
    expect(pairing.poll(challenge.id, challenge.pollSecret)).toEqual(first);
    pairing.ack(challenge.id, first.credential);
    now += 5000;
    expect(() => pairing.poll(challenge.id, challenge.pollSecret)).toThrow();
    expect(
      JSON.stringify(h.db.prepare("SELECT * FROM devices").all()),
    ).not.toContain(first.credential);
  } finally {
    await h.close();
  }
});
it("expires codes and rejects polls faster than five seconds", async () => {
  const h = await createHarness();
  try {
    let now = 10000;
    const pairing = new PairingService(h.db, Buffer.alloc(32, 2), () => now);
    const c = pairing.create("TV");
    pairing.poll(c.id, c.pollSecret);
    expect(() => pairing.poll(c.id, c.pollSecret)).toThrow();
    now += 600001;
    expect(() => pairing.approve(c.code)).toThrow();
    expect(() => pairing.poll(c.id, c.pollSecret)).toThrow();
  } finally {
    await h.close();
  }
});
