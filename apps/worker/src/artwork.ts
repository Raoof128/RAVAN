import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Database } from "../../../packages/db/src/open.js";
import { inputFormats } from "./compatibility.js";
import { runProcess } from "./process.js";
import type { Probe } from "./probe.js";

/**
 * Pictures for the library, made from the films themselves.
 *
 * A film can carry its own cover: Matroska files keep one as an attachment
 * (by convention "cover.jpg", and "cover_land.jpg" for a wide one), and MP4
 * files as an attached picture. Otherwise a representative frame is taken
 * from a few points in the film, and the most detailed of them kept. Nothing
 * leaves the server: these come from the owner's own files.
 */
export const ARTWORK_FILE = /^[a-f0-9]{32}\.(jpg|png)$/;
export type ArtworkKind = "poster" | "still";
/** Where a picture came from, best first when several exist. */
export const ARTWORK_PROVIDERS = ["tmdb", "cover", "frame"] as const;
export type ArtworkProvider = (typeof ARTWORK_PROVIDERS)[number];
export type Picture = {
  kind: ArtworkKind;
  provider: ArtworkProvider;
  /** A file in the artwork directory. */
  file: string;
};
export const POSTER = { width: 480, height: 720 };
export const STILL_WIDTH = 1280;
/** Images larger than this are refused, whatever their source. */
export const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
/**
 * The most pixels FFmpeg may decode for a picture: the largest frame a film
 * can have here. A cover is the film's own data, and a flat image of a quarter
 * of a billion pixels is under a megabyte to carry and about a gigabyte to
 * decode, inside a worker that shares two with a running conversion.
 */
export const MAX_PICTURE_PIXELS = 8192 * 8192;
/** A cover needs far less: 40 megapixels is larger than any poster scan. */
export const MAX_COVER_PIXELS = 40_000_000;

export function artworkDirectory(dataDir: string) {
  return join(dataDir, "artwork");
}
export function artworkName(extension: "jpg" | "png" = "jpg") {
  return `${randomBytes(16).toString("hex")}.${extension}`;
}

const stream = z.object({
  index: z.number().int().nonnegative(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  tags: z
    .object({
      filename: z.string().max(4096).optional(),
      mimetype: z.string().max(64).optional(),
    })
    .passthrough()
    .optional(),
  disposition: z
    .object({ attached_pic: z.number().optional() })
    .passthrough()
    .optional(),
});

let filterList: Promise<string> | undefined;
/** Whether this FFmpeg has the filters HDR tone mapping needs. */
async function canToneMap(signal: AbortSignal) {
  filterList ??= runProcess(
    "ffmpeg",
    ["-hide_banner", "-filters"],
    signal,
    15000,
  ).catch(() => "");
  const filters = await filterList;
  return /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters);
}

const encode = ["-q:v", "3", "-f", "image2", "-update", "1"];

export async function extractArtwork(
  source: string,
  headers: string | undefined,
  probe: Probe,
  directory: string,
  signal: AbortSignal,
): Promise<Picture[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const input = [
    "-max_pixels",
    String(MAX_PICTURE_PIXELS),
    "-protocol_whitelist",
    "file,http,tcp",
    "-format_whitelist",
    inputFormats,
    ...(headers ? ["-headers", headers] : []),
  ];
  const pictures: Picture[] = [];
  const scratch: string[] = [];
  const temporary = () => {
    const path = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
    scratch.push(path);
    return path;
  };
  /** Keep a finished file under its final, random name. */
  const keep = async (
    path: string,
    kind: ArtworkKind,
    provider: ArtworkProvider,
  ) => {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1024 || info.size > MAX_ARTWORK_BYTES)
      return;
    const file = artworkName();
    await rename(path, join(directory, file));
    pictures.push({ kind, provider, file });
  };
  /** Scale and crop any image to the poster or still shape, as JPEG. */
  const shape = async (
    from: string[],
    kind: ArtworkKind,
    filters: string[] = [],
  ) => {
    const out = temporary();
    await runProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        ...from,
        "-frames:v",
        "1",
        "-vf",
        [
          ...filters,
          kind === "poster"
            ? `scale=${POSTER.width}:${POSTER.height}:force_original_aspect_ratio=increase,crop=${POSTER.width}:${POSTER.height}`
            : `scale=${STILL_WIDTH}:-2`,
          "format=yuvj420p",
        ].join(","),
        ...encode,
        out,
      ],
      signal,
      90000,
    );
    return out;
  };
  try {
    // 1. A cover the film carries.
    // An unusual listing is no reason to skip the frames: treat it as no cover.
    const listing = await runProcess(
      "ffprobe",
      [
        "-v",
        "error",
        ...input,
        "-show_entries",
        "stream=index,codec_type,codec_name,width,height:stream_tags=filename,mimetype:stream_disposition=attached_pic",
        "-of",
        "json",
        source,
      ],
      signal,
      30000,
    )
      .then(
        (raw) =>
          z
            .object({ streams: z.array(stream).max(1000) })
            .safeParse(JSON.parse(raw)).data?.streams ?? [],
      )
      .catch((error: unknown) => {
        if (signal.aborted) throw error;
        return [];
      });
    const images = listing.filter(
      (s) =>
        (s.codec_type === "attachment" &&
          /^image\/(jpeg|png)$/.test(s.tags?.mimetype ?? "")) ||
        (s.codec_type === "video" && s.disposition?.attached_pic === 1),
    );
    const named = (pattern: RegExp) =>
      images.find((s) => pattern.test(s.tags?.filename ?? ""));
    const wide = (s: z.infer<typeof stream>) =>
      (s.width ?? 0) > (s.height ?? 0) * 1.1;
    const cover =
      named(/^cover\.(jpe?g|png)$/i) ??
      named(/^(?!.*land).*cover.*\.(jpe?g|png)$/i) ??
      images.find((s) => s.codec_type === "video" && !wide(s)) ??
      images.find((s) => !/land|back|disc|logo/i.test(s.tags?.filename ?? ""));
    const landscape =
      named(/^cover_land\.(jpe?g|png)$/i) ??
      images.find((s) => s.codec_type === "video" && wide(s));
    for (const [kind, image] of [
      ["poster", cover],
      ["still", landscape],
    ] as const) {
      if (!image) continue;
      try {
        let from: string[];
        if (image.codec_type === "attachment") {
          // An attachment is copied out as it is stored, then read locally.
          const raw = temporary();
          await runProcess(
            "ffmpeg",
            [
              "-nostdin",
              "-v",
              "error",
              ...input,
              `-dump_attachment:${image.index}`,
              raw,
              "-i",
              source,
              "-t",
              "0",
              "-f",
              "null",
              "-",
            ],
            signal,
            60000,
          );
          const info = await stat(raw);
          if (info.size > MAX_ARTWORK_BYTES) continue;
          from = [
            "-max_pixels",
            String(MAX_COVER_PIXELS),
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "image2,jpeg_pipe,png_pipe",
            "-i",
            raw,
          ];
        } else
          from = [
            ...input,
            // Later options win: a cover is held to a cover's size.
            "-max_pixels",
            String(MAX_COVER_PIXELS),
            "-i",
            source,
            "-map",
            `0:${image.index}`,
          ];
        await keep(await shape(from, kind), kind, "cover");
      } catch {
        // A damaged cover is no reason to go without a picture.
      }
    }
    // 2. Frames from the film, for whatever the film did not provide.
    if (!probe.video || pictures.length === 2) return pictures;
    const filters: string[] = [];
    if (probe.video.sar)
      filters.push(`scale=trunc(iw*${probe.video.sar}/2)*2:ih`, "setsar=1");
    if (probe.video.interlaced) filters.push("bwdif=mode=send_frame");
    if (probe.video.hdr && (await canToneMap(signal)))
      filters.push(
        `zscale=w=${STILL_WIDTH}:h=-2:t=linear:npl=100`,
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=mobius:desat=2",
        "zscale=t=bt709:m=bt709:r=tv",
      );
    // The most representative of a second of frames at each point. They are
    // made small first: the filter holds all 24, and at full size an 8K film's
    // would be well over a gigabyte.
    filters.push(`scale=${STILL_WIDTH}:-2`, "thumbnail=n=24");
    const seconds = probe.durationMs / 1000;
    const points = (seconds > 120 ? [0.2, 0.35, 0.5, 0.65] : [0.3, 0.6]).map(
      (f) => Math.max(0, Math.floor(seconds * f)),
    );
    const frames: Array<{ path: string; size: number }> = [];
    for (const at of points) {
      try {
        const path = await shape(
          [
            ...input,
            "-ss",
            String(at),
            "-i",
            source,
            "-map",
            "0:v:0",
            "-an",
            "-sn",
          ],
          "still",
          filters,
        );
        frames.push({ path, size: (await stat(path)).size });
      } catch {
        // A point that cannot be read is skipped; the others may do.
      }
    }
    // Not one point could be read: the film was unreachable, not without
    // pictures. Fail, so the job is tried again rather than finished empty.
    if (!frames.length && !pictures.length)
      throw new Error("Film unreadable for pictures");
    // A flat or dark frame compresses to little: the largest has the most in it.
    const best = frames
      .filter((f) => f.size >= 12 * 1024)
      .sort((a, b) => b.size - a.size)[0];
    if (!best) return pictures;
    if (!pictures.some((p) => p.kind === "poster")) {
      // The poster is the middle of the same frame, the title set over it.
      const poster = await shape(
        [
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          "image2,jpeg_pipe",
          "-i",
          best.path,
        ],
        "poster",
        ["crop=min(iw\\,trunc(ih*2/3)):ih"],
      );
      await keep(poster, "poster", "frame");
    }
    if (!pictures.some((p) => p.kind === "still"))
      await keep(best.path, "still", "frame");
    return pictures;
  } catch (error) {
    // Nothing half made is left: remove what this run kept, then fail.
    await Promise.all(
      pictures.map((p) => rm(join(directory, p.file), { force: true })),
    );
    throw error;
  } finally {
    await Promise.all(scratch.map((path) => rm(path, { force: true })));
  }
}

/** Decoders a book's picture may use: the formats books carry pictures in. */
const IMAGE_FORMATS = "image2,jpeg_pipe,png_pipe,webp_pipe,gif,gif_pipe";

/**
 * Make a poster from a picture file taken out of a book, held to a cover's
 * size. Undefined when FFmpeg makes nothing worth keeping.
 */
export async function posterFromImage(
  path: string,
  directory: string,
  signal: AbortSignal,
): Promise<Picture | undefined> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const out = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await runProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-max_pixels",
        String(MAX_COVER_PIXELS),
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        IMAGE_FORMATS,
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        `scale=${POSTER.width}:${POSTER.height}:force_original_aspect_ratio=increase,crop=${POSTER.width}:${POSTER.height},format=yuvj420p`,
        ...encode,
        out,
      ],
      signal,
      90000,
    );
    const info = await stat(out);
    if (!info.isFile() || info.size < 1024 || info.size > MAX_ARTWORK_BYTES)
      return;
    const file = artworkName();
    await rename(out, join(directory, file));
    return { kind: "poster", provider: "cover", file };
  } finally {
    await rm(out, { force: true });
  }
}

/**
 * Replace a film's pictures from the given providers with new ones, in one
 * transaction, then remove the files of those they replaced. If recording
 * fails, the new files are removed instead. Other providers are untouched.
 */
export async function storeArtwork(
  db: Database,
  directory: string,
  movieId: string,
  generation: string,
  provider: ArtworkProvider | ArtworkProvider[],
  pictures: Picture[],
  now = Date.now(),
) {
  const providers = Array.isArray(provider) ? provider : [provider];
  const kept = pictures.filter((p) => providers.includes(p.provider));
  let old: Array<{ path: string }>;
  try {
    old = db.transaction(() => {
      const previous: Array<{ path: string }> = [];
      for (const name of providers) {
        previous.push(
          ...(db
            .prepare("SELECT path FROM artwork WHERE movie_id=? AND provider=?")
            .all(movieId, name) as Array<{ path: string }>),
        );
        db.prepare("DELETE FROM artwork WHERE movie_id=? AND provider=?").run(
          movieId,
          name,
        );
      }
      for (const picture of kept)
        db.prepare(
          "INSERT INTO artwork(id,movie_id,path,provider,kind,generation,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          picture.file.slice(0, 32),
          movieId,
          picture.file,
          picture.provider,
          picture.kind,
          generation,
          now,
        );
      return previous;
    })();
  } catch (error) {
    await Promise.all(
      kept.map((p) => rm(join(directory, p.file), { force: true })),
    );
    throw error;
  }
  await Promise.all(
    old
      .filter((row) => ARTWORK_FILE.test(row.path))
      .map((row) => rm(join(directory, row.path), { force: true })),
  );
}

/**
 * Remove files no row refers to: left by a worker stopped mid-job, or by a
 * restore. Only files older than an hour, so a job in progress is safe.
 */
export async function sweepArtwork(
  db: Database,
  directory: string,
  now = Date.now(),
) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  // Book covers live beside the films' pictures.
  const known = new Set(
    (
      db
        .prepare(
          "SELECT path FROM artwork UNION ALL SELECT path FROM reading_covers WHERE path IS NOT NULL",
        )
        .all() as Array<{ path: string }>
    ).map((row) => row.path),
  );
  let removed = 0;
  for (const name of names) {
    const ours = ARTWORK_FILE.test(name) || /^\.[a-f0-9]{16}\.tmp$/.test(name);
    if (!ours || known.has(name)) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (!info?.isFile() || now - info.mtimeMs < 3600000) continue;
    await rm(join(directory, name), { force: true });
    removed++;
  }
  return removed;
}

/** Read a stored picture, or undefined when it is not one of ours. */
export async function readArtwork(directory: string, file: string) {
  if (!ARTWORK_FILE.test(file)) return;
  const bytes = await readFile(join(directory, file));
  return bytes.length <= MAX_ARTWORK_BYTES ? bytes : undefined;
}
