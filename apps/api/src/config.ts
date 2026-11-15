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
  })
  .superRefine((v, ctx) => {
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
    origin: process.env.MOV_ORIGIN,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    ownerSubject: process.env.MOV_OWNER_SUBJECT,
    encryptionKey: process.env.MOV_ENCRYPTION_KEY,
  });
}
