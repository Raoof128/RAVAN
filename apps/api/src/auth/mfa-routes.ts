import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MfaService } from "./mfa.js";
import { equal } from "./sessions.js";

export function registerMfaRoutes(
  app: FastifyInstance,
  mfa: MfaService | undefined,
  origin: string,
) {
  const authenticate = (request: FastifyRequest, reply: FastifyReply) => {
    const challenge = mfa?.challenge(request.cookies.mov_mfa);
    if (!challenge) {
      reply.code(401).send({ error: "mfa_expired" });
      return;
    }
    const csrf = request.headers["x-csrf-token"];
    if (
      request.headers.origin !== origin ||
      typeof csrf !== "string" ||
      !equal(csrf, challenge.csrf)
    ) {
      reply.code(403).send({ error: "csrf_failed" });
      return;
    }
    return challenge;
  };
  const options = {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  };
  app.post("/auth/mfa/enroll", options, async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const result = mfa!.enrollment(request.cookies.mov_mfa!);
    return "error" in result
      ? reply.code(result.status).send({ error: result.error })
      : result;
  });
  app.post("/auth/mfa/verify", options, async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const body = z
      .strictObject({
        code: z.string().min(1).max(64),
        recovery: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = mfa!.verify(
      request.cookies.mov_mfa!,
      body.data.code,
      body.data.recovery,
    );
    if ("error" in result) {
      if (result.status === 429) reply.header("Retry-After", "900");
      return reply.code(result.status).send({ error: result.error });
    }
    if ("recoveryRequired" in result) return result;
    reply.clearCookie("mov_mfa", { path: "/" });
    reply.setCookie("mov_session", result.session.token, {
      httpOnly: true,
      secure: origin.startsWith("https://"),
      sameSite: "lax",
      path: "/",
      expires: new Date(result.session.expires),
    });
    return {
      authenticated: true,
      ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
    };
  });
  app.post("/auth/mfa/cancel", options, async (request, reply) => {
    if (!authenticate(request, reply)) return;
    mfa!.cancel(request.cookies.mov_mfa!);
    reply.clearCookie("mov_mfa", { path: "/" });
    return reply.code(204).send();
  });
}
