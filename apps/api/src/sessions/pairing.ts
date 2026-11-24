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
/** How long a screen may finish acknowledgement after first collection. */
const DELIVERY_MS = 60000;
export function listedDevices(db: Database, now = Date.now()) {
  return db
    .prepare(
      `
    SELECT d.id,d.name,CASE WHEN d.awaiting_ack=1 THEN 'awaitingDevice' ELSE 'paired' END AS pairingState
    FROM devices d LEFT JOIN pairing_requests p ON p.id=d.pairing_request_id
    WHERE d.revoked_at IS NULL AND
      (d.awaiting_ack=0 OR (p.state='approved' AND coalesce(p.delivered_at + ?, p.expires_at)>?))
    ORDER BY d.name,d.id
  `,
    )
    .all(DELIVERY_MS, now);
}
export class PairingService {
  private polled = new Map<string, number>();
  constructor(
    private db: Database,
    private key: Buffer,
    private now = Date.now,
  ) {}
  expire() {
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE devices SET revoked_at=? WHERE revoked_at IS NULL AND awaiting_ack=1 AND
           id IN (SELECT device_id FROM pairing_requests WHERE state='approved'
                  AND coalesce(delivered_at + ?, expires_at)<=?)`,
        )
        .run(now, DELIVERY_MS, now);
      this.db
        .prepare("DELETE FROM pairing_requests WHERE expires_at<?")
        .run(now - DELIVERY_MS);
    })();
  }
  create(name: string) {
    const now = this.now();
    this.expire();
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
  approve(code: string, watchlistWrite = false, reading = false) {
    this.db
      .transaction(() => {
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
          .prepare(
            "INSERT INTO devices(id,name,token_hash,watchlist_write,reading,pairing_request_id,awaiting_ack) VALUES(?,?,?,?,?,?,1)",
          )
          .run(
            device,
            name,
            hash(credential),
            Number(watchlistWrite),
            Number(reading),
            row.id,
          );
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
            "UPDATE pairing_requests SET state='approved',device_id=?,delivery_ciphertext=? WHERE id=?",
          )
          .run(device, encrypted, row.id);
      })
      .immediate();
  }
  poll(
    id: string,
    pollSecret: string,
  ):
    | { state: "pending" }
    | { state: "approved"; credential: string; deviceId: string } {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            `SELECT p.* FROM pairing_requests p LEFT JOIN devices d ON d.id=p.device_id
                WHERE p.id=? AND (p.state='pending' OR (p.state='approved' AND d.awaiting_ack=1 AND d.revoked_at IS NULL))`,
          )
          .get(id) as Row | undefined;
        const now = this.now();
        if (
          !row ||
          (row.delivered_at === null
            ? row.expires_at <= now
            : now - row.delivered_at >= DELIVERY_MS) ||
          !equal(hash(pollSecret), row.poll_hash)
        )
          throw new Error("Pairing unavailable");
        const last = this.polled.get(id);
        if (last !== undefined && now - last < 5000)
          throw new Error("Poll too quickly");
        this.polled.set(id, now);
        if (row.state === "pending") return { state: "pending" as const };
        // Safari may have held the iPhone in the background since approval.
        // Start its short acknowledgement window on the first successful poll.
        if (row.delivered_at === null)
          this.db
            .prepare("UPDATE pairing_requests SET delivered_at=? WHERE id=?")
            .run(now, id);
        const bytes = Buffer.from(row.delivery_ciphertext!, "base64"),
          cipher = createDecipheriv(
            "aes-256-gcm",
            this.key,
            bytes.subarray(0, 12),
          );
        cipher.setAAD(Buffer.from(row.id));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return {
          state: "approved" as const,
          deviceId: row.device_id!,
          credential: Buffer.concat([
            cipher.update(bytes.subarray(28)),
            cipher.final(),
          ]).toString(),
        };
      })
      .immediate();
  }
  ack(id: string, credential: string) {
    this.db
      .transaction(() => {
        const device = this.db
          .prepare(
            "SELECT id,awaiting_ack FROM devices WHERE token_hash=? AND pairing_request_id=? AND revoked_at IS NULL",
          )
          .get(hash(credential), id) as
          { id: string; awaiting_ack: number } | undefined;
        if (!device) throw new Error("Pairing unavailable");
        // If the first HTTP response was lost, the original request and active
        // credential still prove this particular device completed the exchange.
        if (!device.awaiting_ack) return;
        const consumed = this.db
          .prepare(
            `UPDATE pairing_requests SET state='consumed',delivery_ciphertext=NULL
         WHERE id=? AND device_id=? AND state='approved' AND delivered_at>?`,
          )
          .run(id, device.id, this.now() - DELIVERY_MS);
        if (!consumed.changes) throw new Error("Pairing unavailable");
        this.db
          .prepare("UPDATE devices SET awaiting_ack=0 WHERE id=?")
          .run(device.id);
      })
      .immediate();
  }
}
