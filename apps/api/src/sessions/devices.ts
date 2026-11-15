import type { Database } from "../../../../packages/db/src/open.js";
import type { FastifyRequest } from "fastify";
import { hash, findSession } from "../auth/sessions.js";
export type Principal = { webHash?: string; deviceId?: string };
export function findDevice(db: Database, request: FastifyRequest) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.authorization ?? "",
  );
  if (!match) return;
  return db
    .prepare(
      "SELECT id,name FROM devices WHERE token_hash=? AND revoked_at IS NULL",
    )
    .get(hash(match[1]!)) as { id: string; name: string } | undefined;
}
export function principal(db: Database, request: FastifyRequest): Principal {
  const device = findDevice(db, request);
  if (device) return { deviceId: device.id };
  const session = findSession(db, request);
  if (session) return { webHash: session.token_hash };
  throw new Error("Unauthenticated");
}
export function owns(
  row: { device_id: string | null; web_session_hash: string | null },
  who: Principal,
) {
  return Boolean(
    (who.deviceId && row.device_id === who.deviceId) ||
    (who.webHash && row.web_session_hash === who.webHash),
  );
}
export function revokeDevice(db: Database, id: string) {
  db.transaction(() => {
    db.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run(
      Date.now(),
      id,
    );
    db.prepare(
      "UPDATE playback_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL",
    ).run(Date.now(), id);
  })();
}
