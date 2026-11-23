import type { FastifyRequest } from "fastify";
import { equal, type OwnerSession } from "./sessions.js";
export function validCsrf(
  request: FastifyRequest,
  session: Pick<OwnerSession, "csrf">,
  origin: string,
): boolean {
  const token = request.headers["x-csrf-token"];
  return (
    request.headers.origin === origin &&
    typeof token === "string" &&
    equal(token, session.csrf)
  );
}
