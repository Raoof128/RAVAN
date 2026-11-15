import { z } from "zod";
import { resolve } from "node:path";
const schema = z
  .strictObject({
    mode: z.enum(["development", "test", "production"]).default("development"),
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.coerce.number().int().min(1024).max(65535).default(4310),
    dataDir: z.string().min(1).default(resolve(".local/data")),
    origin: z.string().url().default("http://localhost:4310"),
    minFreeBytes: z
      .number()
      .int()
      .nonnegative()
      .default(30 * 1024 ** 3),
    preparedDir: z.string().min(1).optional(),
    // Measured on a 2-vCPU server: superfast encodes 1.6x faster than veryfast
    // for about 8% more bits and no measurable quality loss; ultrafast is worse.
    encoderPreset: z
      .enum(["superfast", "veryfast", "faster", "fast", "medium"])
      .default("superfast"),
    encoderThreads: z.coerce.number().int().min(1).max(16).optional(),
    // "hls" editions can be played while they are still being prepared.
    preparedFormat: z.enum(["hls", "mp4"]).default("hls"),
    // Size of the prepared-editions filesystem. Production refuses a larger one,
    // so the volume cannot silently grow into the space the database needs.
    preparedCapacityBytes: z.coerce
      .number()
      .int()
      // Below this an edition and its neighbours cannot both fit.
      .min(8 * 1024 ** 3)
      .max(1024 ** 4)
      .default(20 * 1024 ** 3),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    ownerSubject: z.string().optional(),
    workerKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    encryptionKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    // TMDB's API Read Access Token. Unset, no title ever leaves the server.
    tmdbToken: z
      .string()
      .regex(/^[A-Za-z0-9._-]{20,1000}$/)
      .optional(),
  })
  .superRefine((v, ctx) => {
    // CSRF compares the browser's Origin header to this value exactly. A trailing
    // slash or path would start cleanly and then reject every state change.
    if (!URL.canParse(v.origin) || new URL(v.origin).origin !== v.origin)
      ctx.addIssue({
        code: "custom",
        message: "origin must be scheme://host[:port] with no path",
      });
    if (v.mode === "production") {
      if (v.minFreeBytes < 30 * 1024 ** 3)
        ctx.addIssue({
          code: "custom",
          message: "Production reserve must be at least 30 GiB",
        });
      if (!v.origin.startsWith("https://"))
        ctx.addIssue({ code: "custom", message: "HTTPS origin required" });
      for (const key of [
        "clientId",
        "clientSecret",
        "ownerSubject",
        "encryptionKey",
      ] as const)
        if (!v[key])
          ctx.addIssue({ code: "custom", message: `Missing ${key}` });
    }
  });
export type AppConfig = z.infer<typeof schema>;
export function parseConfig(input: unknown): AppConfig {
  return schema.parse(input);
}
export function environmentConfig(): AppConfig {
  return parseConfig({
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
    port: process.env.PORT,
    workerKey: process.env.MOV_WORKER_KEY,
    minFreeBytes: process.env.MOV_MIN_FREE_BYTES
      ? Number(process.env.MOV_MIN_FREE_BYTES)
      : undefined,
    dataDir: process.env.MOV_DATA_DIR,
    preparedDir: process.env.MOV_PREPARED_DIR,
    encoderPreset: process.env.MOV_ENCODER_PRESET || undefined,
    encoderThreads: process.env.MOV_ENCODER_THREADS || undefined,
    preparedFormat: process.env.MOV_PREPARED_FORMAT || undefined,
    preparedCapacityBytes: process.env.MOV_PREPARED_CAPACITY_BYTES || undefined,
    origin: process.env.MOV_ORIGIN,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    ownerSubject: process.env.MOV_OWNER_SUBJECT,
    encryptionKey: process.env.MOV_ENCRYPTION_KEY,
    tmdbToken: process.env.MOV_TMDB_TOKEN || undefined,
  });
}
/**
 * A reason an operator can act on, without configuration values. Validation
 * issues name the setting and the rule; other failures give their error code or
 * the fixed message raised by this codebase.
 */
export function startupReason(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
  if (error instanceof Error)
    return (error as NodeJS.ErrnoException).code ?? error.message;
  return "unknown";
}
