import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { createHarness } from "../fixtures/harness.js";
import {
  PairingService,
  listedDevices,
} from "../../apps/api/src/sessions/pairing.js";
import {
  issueSession,
  hash,
  secret,
} from "../../apps/api/src/auth/sessions.js";
import { migrate } from "../../packages/db/src/migrate.js";
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

it("waits for the device to acknowledge and can recover a lost acknowledgement response", async () => {
  const origin = "https://cinema.example";
  const h = await createHarness({ origin, encryptionKey: "ab".repeat(32) });
  try {
    const owner = issueSession(h.db, "owner");
    const headers = {
      origin,
      cookie: "mov_session=" + owner.token,
      "x-csrf-token": owner.csrf,
    };
    const devices = async () =>
      (await h.app.inject({ url: "/api/devices", headers })).json();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/pairing",
      payload: { name: "Fixture iPhone" },
    });
    expect(created.statusCode).toBe(200);
    const { id, code, pollSecret } = created.json();
    expect(await devices()).toEqual([]);
    const approved = await h.app.inject({
      method: "POST",
      url: "/api/pairing/approve",
      headers,
      payload: { code, reading: true },
    });
    expect(approved.statusCode).toBe(204);
    const listed = await devices();
    expect(listed).toEqual([
      {
        id: expect.any(String),
        name: "Fixture iPhone",
        pairingState: "awaitingDevice",
      },
    ]);
    const delivered = await h.app.inject({
      method: "POST",
      url: "/api/pairing/poll",
      payload: { id, pollSecret },
    });
    expect(delivered.statusCode).toBe(200);
    const { credential, deviceId } = delivered.json();
    expect(delivered.json()).toEqual({
      state: "approved",
      credential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      deviceId: listed[0].id,
    });
    const bearer = { authorization: "Bearer " + credential };
    const session = async () =>
      (await h.app.inject({ url: "/api/session", headers: bearer })).json();
    const ack = (requestId: string) =>
      h.app.inject({
        method: "POST",
        url: "/api/pairing/ack",
        headers: bearer,
        payload: { id: requestId },
      });
    expect(await devices()).toEqual(listed);
    expect((await session()).authenticated).toBe(false);
    expect(
      (await h.app.inject({ url: "/api/movies", headers: bearer })).statusCode,
    ).toBe(401);
    expect((await ack(deviceId)).statusCode).toBe(400);
    expect((await ack(id)).statusCode).toBe(204);
    expect(await devices()).toEqual([
      { id: deviceId, name: "Fixture iPhone", pairingState: "paired" },
    ]);
    expect(await session()).toMatchObject({
      authenticated: true,
      deviceId,
      permissions: ["reading:read"],
    });
    h.db.prepare("DELETE FROM pairing_requests WHERE id=?").run(id);
    expect((await ack(id)).statusCode).toBe(204);
    expect((await ack(deviceId)).statusCode).toBe(400);
    await h.app.inject({
      method: "DELETE",
      url: "/api/devices/" + deviceId,
      headers,
    });
    expect((await ack(id)).statusCode).toBe(401);
    expect((await session()).authenticated).toBe(false);
  } finally {
    await h.close();
  }
});

it("allows a backgrounded phone to collect until code expiry and limits acknowledgement from first collection", async () => {
  const h = await createHarness();
  try {
    let now = 10000;
    const pairing = new PairingService(h.db, Buffer.alloc(32, 2), () => now);
    const c = pairing.create("Phone");
    pairing.approve(c.code);
    now += 590000;
    pairing.expire();
    const first = pairing.poll(c.id, c.pollSecret);
    if (first.state !== "approved") throw Error("Expected approved device");
    now += 5000;
    expect(pairing.poll(c.id, c.pollSecret)).toEqual(first);
    now += 10000; // The displayed code expired after the first delivery.
    expect(pairing.poll(c.id, c.pollSecret)).toEqual(first);
    now += 45000;
    expect(() => pairing.ack(c.id, first.credential)).toThrow();
    expect(listedDevices(h.db, now)).toEqual([]);
    pairing.expire();
    expect(
      h.db
        .prepare("SELECT revoked_at FROM devices WHERE id=?")
        .get(first.deviceId),
    ).toEqual({ revoked_at: now });
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

it("upgrades schema 14 without reviving expired approvals or unpairing established screens", () => {
  const db = new Sqlite(":memory:");
  try {
    const migrations = new URL(
      "../../packages/db/migrations/",
      import.meta.url,
    );
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (const file of readdirSync(migrations)
      .filter((file) => Number(file.slice(0, 3)) <= 14)
      .sort()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?,0)").run(
        Number(file.slice(0, 3)),
      );
    }
    const now = Date.now();
    const credentials = new Map<string, string>();
    for (const name of ["expired", "waiting", "consumed", "established"]) {
      const credential = secret();
      credentials.set(name, credential);
      db.prepare(
        "INSERT INTO devices(id,name,token_hash,reading) VALUES(?,?,?,1)",
      ).run(name, name, hash(credential));
      if (name !== "established") {
        db.prepare(
          `INSERT INTO pairing_requests(id,code_hash,poll_hash,device_id,state,delivered_at,expires_at)
          VALUES(?,?,?,?,?,?,?)`,
        ).run(
          name,
          hash(name),
          hash(name),
          name,
          name === "consumed" ? "consumed" : "approved",
          name === "expired" ? now - 120000 : now,
          name === "expired" ? now - 10000 : now + 600000,
        );
      }
    }
    migrate(db);
    expect(listedDevices(db)).toEqual([
      { id: "consumed", name: "consumed", pairingState: "paired" },
      { id: "established", name: "established", pairingState: "paired" },
      { id: "waiting", name: "waiting", pairingState: "awaitingDevice" },
    ]);
    expect(
      db.prepare("SELECT revoked_at FROM devices WHERE id='expired'").get(),
    ).toEqual({ revoked_at: expect.any(Number) });
    const pairing = new PairingService(db, Buffer.alloc(32, 3));
    expect(() => pairing.ack("expired", credentials.get("expired")!)).toThrow();
    pairing.ack("consumed", credentials.get("consumed")!);
    pairing.ack("waiting", credentials.get("waiting")!);
    expect(listedDevices(db)).toContainEqual({
      id: "waiting",
      name: "waiting",
      pairingState: "paired",
    });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM devices WHERE reading=1 AND revoked_at IS NULL AND awaiting_ack=0",
        )
        .get(),
    ).toEqual({ n: 3 });
  } finally {
    db.close();
  }
});
