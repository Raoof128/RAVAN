import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "../../../../packages/db/src/open.js";
import type { FastifyRequest } from "fastify";
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export type OwnerSession = {
  subject: string;
  csrf: string;
  token_hash: string;
  expires_at: number;
};
export function findSession(
  db: Database,
  request: FastifyRequest,
): OwnerSession | undefined {
  const token = request.cookies.mov_session;
  if (!token || token.length > 128) return;
  return db
    .prepare("SELECT * FROM web_sessions WHERE token_hash=? AND expires_at>?")
    .get(hash(token), Date.now()) as OwnerSession | undefined;
}
export function issueSession(db: Database, subject: string) {
  const token = secret();
  const csrf = secret();
  const expires = Date.now() + 7 * 86400000;
  db.prepare("INSERT INTO web_sessions VALUES (?,?,?,?)").run(
    hash(token),
    subject,
    csrf,
    expires,
  );
  return { token, csrf, expires };
}
