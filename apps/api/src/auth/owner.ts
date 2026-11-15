import type { FastifyRequest } from "fastify";
import type { Database } from "../../../../packages/db/src/open.js";
import { findSession } from "./sessions.js";
export async function requireOwner(
  request: FastifyRequest,
): Promise<{ subject: string }> {
  const db = request.server.getDecorator<Database>("database");
  const session = findSession(db, request);
  if (!session)
    throw Object.assign(new Error("Authentication required"), {
      statusCode: 401,
    });
  return { subject: session.subject };
}
