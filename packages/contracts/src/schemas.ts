import { z } from "zod";
export const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const milliseconds = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const progressSchema = z.strictObject({
  sessionId: idSchema,
  epoch: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  positionMs: milliseconds,
  ended: z.boolean(),
});
export const capabilitiesSchema = z.strictObject({
  video: z
    .array(z.enum(["h264", "hevc", "hevc10", "av1", "vp9", "vp8"]))
    .max(6),
  audio: z
    .array(z.enum(["aac", "mp3", "ac3", "eac3", "flac", "opus", "vorbis"]))
    .max(7),
  containers: z.array(z.enum(["mp4", "webm", "matroska"])).max(3),
});
export const playbackSchema = z.strictObject({
  movieId: idSchema,
  profileId: idSchema,
  startMs: milliseconds.default(0),
  replaceSessionId: idSchema.optional(),
  quality: z
    .enum(["auto", "original", "480p", "720p", "1080p", "1440p", "2160p"])
    .default("auto"),
  audioTrack: z.number().int().min(0).max(99).optional(),
  forceCompatible: z.boolean().default(false),
  capabilities: capabilitiesSchema.optional(),
});
export const preferencesSchema = z.strictObject({
  audioLanguage: z.string().max(32).default("original"),
  subtitleLanguage: z.string().max(32).default("off"),
  quality: z.enum(["original", "720p", "1080p"]).default("original"),
  reducedMotion: z.boolean().default(false),
});
export const metadataSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  year: z.number().int().min(1888).max(2200).optional(),
  description: z.string().max(5000).optional(),
});
