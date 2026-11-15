import {
  randomInt,
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { Database } from "../../../../packages/db/src/open.js";
import { hash, secret, equal } from "../auth/sessions.js";
type Row = {
  id: string;
  code_hash: string;
  poll_hash: string;
  expires_at: number;
  attempts: number;
  state: string;
  delivery_ciphertext: string | null;
  device_id: string | null;
  delivered_at: number | null;
};
export class PairingService {
  private polled = new Map<string, number>();
  constructor(
    private db: Database,
    private key: Buffer,
    private now = Date.now,
  ) {}
  create(name: string) {
    const now = this.now();
    this.db
      .prepare("DELETE FROM pairing_requests WHERE expires_at<?")
      .run(now - 60000);
    for (const [id, time] of this.polled)
      if (time < now - 600000) this.polled.delete(id);
    // Anyone can start a pairing, so a full table must not refuse a real TV.
    // Drop the oldest request nobody has approved; approved ones are kept.
    const count = () =>
      (
        this.db.prepare("SELECT COUNT(*) n FROM pairing_requests").get() as {
          n: number;
        }
      ).n;
    while (count() >= 100)
      if (
        !this.db
          .prepare(
            "DELETE FROM pairing_requests WHERE id=(SELECT id FROM pairing_requests WHERE state='pending' ORDER BY expires_at,rowid LIMIT 1)",
          )
          .run().changes
      )
        throw new Error("Pairing capacity");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(
      { length: 8 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
    const id = randomUUID(),
      pollSecret = secret();
    this.db
      .prepare(
        "INSERT INTO pairing_requests(id,code_hash,poll_hash,expires_at,delivery_ciphertext) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        hash(code),
        hash(pollSecret),
        now + 600000,
        JSON.stringify({ name: name.slice(0, 80) }),
      );
    return {
      id,
      code,
      pollSecret,
      expiresAt: new Date(now + 600000).toISOString(),
      pollIntervalMs: 5000,
    };
  }
  approve(code: string) {
    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM pairing_requests WHERE code_hash=?")
        .get(hash(code)) as Row | undefined;
      if (!row || row.expires_at <= this.now() || row.state !== "pending")
        throw new Error("Pairing unavailable");
      const credential = secret(),
        device = randomUUID();
      const name = (JSON.parse(row.delivery_ciphertext!) as { name: string })
        .name;
      this.db
        .prepare("INSERT INTO devices(id,name,token_hash) VALUES(?,?,?)")
        .run(device, name, hash(credential));
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(Buffer.from(row.id));
      const body = Buffer.concat([cipher.update(credential), cipher.final()]);
      const encrypted = Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        body,
      ]).toString("base64");
      this.db
        .prepare(
          "UPDATE pairing_requests SET state='approved',device_id=?,delivery_ciphertext=?,delivered_at=? WHERE id=?",
        )
        .run(device, encrypted, this.now(), row.id);
    })();
  }
  poll(
    id: string,
    pollSecret: string,
  ):
    | { state: "pending" }
    | { state: "approved"; credential: string; deviceId: string } {
    const row = this.db
      .prepare("SELECT * FROM pairing_requests WHERE id=?")
      .get(id) as Row | undefined;
    const now = this.now();
    if (
      !row ||
      row.expires_at <= now ||
      !equal(hash(pollSecret), row.poll_hash) ||
      row.state === "consumed"
    )
      throw new Error("Pairing unavailable");
    const last = this.polled.get(id);
    if (last !== undefined && now - last < 5000)
      throw new Error("Poll too quickly");
    this.polled.set(id, now);
    if (row.state === "pending") return { state: "pending" };
    if (row.delivered_at === null || now - row.delivered_at > 60000)
      throw new Error("Delivery expired");
    const bytes = Buffer.from(row.delivery_ciphertext!, "base64"),
      cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(row.id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return {
      state: "approved",
      deviceId: row.device_id!,
      credential: Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString(),
    };
  }
  ack(id: string, credential: string) {
    const row = this.db
      .prepare(
        "SELECT p.* FROM pairing_requests p JOIN devices d ON d.id=p.device_id WHERE p.id=? AND d.token_hash=? AND d.revoked_at IS NULL",
      )
      .get(id, hash(credential)) as Row | undefined;
    if (
      !row ||
      row.state !== "approved" ||
      row.delivered_at === null ||
      this.now() - row.delivered_at > 60000
    )
      throw new Error("Pairing unavailable");
    this.db
      .prepare(
        "UPDATE pairing_requests SET state='consumed',delivery_ciphertext=NULL WHERE id=?",
      )
      .run(id);
  }
}
