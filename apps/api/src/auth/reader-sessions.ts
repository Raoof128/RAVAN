import type { FastifyRequest } from "fastify";
import type { Database } from "../../../../packages/db/src/open.js";
import { hash, secret } from "./sessions.js";

export const READER_COOKIE = "ravan_reader";
export const READER_SESSION_SECONDS = 30 * 60;
type ReaderSession = { token_hash: string; csrf: string };

export function readerCookie(request: FastifyRequest) {
  return request.cookies?.[READER_COOKIE];
}

export function findReaderSession(db: Database, request: FastifyRequest) {
  const token = readerCookie(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  return db
    .prepare(
      `SELECT s.token_hash,s.csrf FROM device_reader_sessions s JOIN devices d ON d.id=s.device_id
     WHERE s.token_hash=? AND s.expires_at>? AND d.revoked_at IS NULL AND d.awaiting_ack=0 AND d.reading=1`,
    )
    .get(hash(token), Date.now()) as ReaderSession | undefined;
}

export function issueReaderSession(db: Database, deviceId: string) {
  return db
    .transaction(() => {
      const approved = db
        .prepare(
          "SELECT id FROM devices WHERE id=? AND revoked_at IS NULL AND reading=1 AND awaiting_ack=0",
        )
        .get(deviceId);
      if (!approved) return;
      const now = Date.now();
      const prior = db
        .prepare(
          "SELECT token_hash,csrf FROM device_reader_sessions WHERE device_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
        )
        .get(deviceId, now) as ReaderSession | undefined;
      // Keep the active page's CSRF proof across renewal and leave its in-flight
      // requests a short overlap. At most two cookie hashes survive per device.
      db.prepare(
        "DELETE FROM device_reader_sessions WHERE device_id=? AND token_hash IS NOT ?",
      ).run(deviceId, prior?.token_hash ?? null);
      if (prior)
        db.prepare(
          "UPDATE device_reader_sessions SET expires_at=min(expires_at,?) WHERE token_hash=?",
        ).run(now + 30000, prior.token_hash);
      const token = secret();
      db.prepare(
        "INSERT INTO device_reader_sessions(token_hash,device_id,csrf,expires_at) VALUES(?,?,?,?)",
      ).run(
        hash(token),
        deviceId,
        prior?.csrf ?? secret(),
        now + READER_SESSION_SECONDS * 1000,
      );
      return token;
    })
    .immediate();
}
