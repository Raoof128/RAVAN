import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import {
  artworkDirectory,
  artworkName,
  MAX_ARTWORK_BYTES,
  storeArtwork,
  type Picture,
} from "../../../worker/src/artwork.js";

/**
 * Posters and backdrops from The Movie Database, for owners who choose it.
 *
 * Off unless MOV_TMDB_TOKEN is set. When on, the server sends each film's
 * title and year to TMDB to find it, and downloads the pictures itself; the
 * browser only ever loads them from this server. A film is matched only when
 * the title agrees and, if a year is known, the year too: a wrong poster is
 * worse than a frame from the film.
 *
 * TMDB's terms ask for this notice wherever its data is used:
 * "This product uses the TMDB API but is not endorsed or certified by TMDB."
 */
export const TMDB_NOTICE =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";
const API = "https://api.themoviedb.org/3";
const IMAGES = "https://image.tmdb.org/t/p";
/** Films tried without success are tried again after this long. */
const RETRY_MS = 30 * 86400000;
/** A network error, a refusal to answer now, or TMDB down: try again tomorrow. */
const ERROR_RETRY_MS = 86400000;
/** Largest search answer read. */
const MAX_SEARCH_BYTES = 1024 * 1024;
/** Read a body, refusing it as soon as it passes the limit. */
async function capped(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
const result = z.object({
  id: z.number().int(),
  title: z.string().max(500).optional(),
  original_title: z.string().max(500).optional(),
  release_date: z.string().max(20).optional(),
  poster_path: z.string().max(100).nullable().optional(),
  backdrop_path: z.string().max(100).nullable().optional(),
});
const search = z.object({ results: z.array(result).max(100) });
const imagePath = /^\/[A-Za-z0-9_-]{8,64}\.(jpg|png)$/;

/** Words that name a file's release, not the film. */
const release =
  /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?\+?|hdr|dv|dolby ?vision|sdr|bluray|blu ray|bdrip|brrip|web ?dl|webrip|web|hdtv|dvdrip|dvd|remux|x26[45]|h ?26[45]|hevc|avc|aac\d?|ac3|eac3|ddp?\d?|dts(-hd)?|truehd|atmos|10bit|8bit|proper|repack|extended|unrated|remastered|imax|multi|dual audio)\b/i;
/**
 * The title and year a file name most likely stands for:
 * "The.Matrix.1999.1080p.BluRay.x264-GROUP" is The Matrix, 1999.
 */
export function releaseQuery(
  name: string,
  knownYear?: number | null,
  /** Leave a trailing year in the title ("Blade Runner 2049"). */
  keepYear = false,
) {
  let text = name
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let year = knownYear ?? undefined;
  // The last year-like word, unless it opens the name ("1917").
  const found = [
    ...text.matchAll(/(?:^|[\s(])((?:19|20)\d{2})(?=[\s)]|$)/g),
  ].at(-1);
  if (found && found.index! > 0) {
    if (!keepYear) year ??= Number(found[1]);
    text = keepYear
      ? text.slice(0, found.index! + found[0].length)
      : text.slice(0, found.index);
  }
  const cut = text.search(release);
  if (cut > 0) text = text.slice(0, cut);
  text = text
    .replace(/[()]/g, " ")
    .replace(/[-–]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { query: text, ...(year ? { year } : {}) };
}
/**
 * What to ask TMDB, best guess first. A year at the end may belong to the
 * title ("Wonder Woman 1984", "Blade Runner 2049"), so when one was read from
 * the name, the name with that year left in is tried as well.
 */
export function releaseQueries(name: string, knownYear?: number | null) {
  const first = releaseQuery(name, knownYear);
  if (!first.year || first.year === knownYear) return [first];
  const whole = releaseQuery(name, knownYear, true);
  if (!whole.query || whole.query === first.query) return [first];
  // A year still to come cannot be a release year: it is part of the title.
  return first.year > new Date().getFullYear() + 1 ? [whole] : [first, whole];
}
function same(a: string, b: string) {
  const normal = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/^(the|a|an) /, "")
      .trim();
  return normal(a) !== "" && normal(a) === normal(b);
}
export function chooseResult(
  results: Array<z.infer<typeof result>>,
  query: { query: string; year?: number },
) {
  const titled = results.filter(
    (r) =>
      same(r.title ?? "", query.query) ||
      same(r.original_title ?? "", query.query),
  );
  if (!query.year)
    // Without a year, only a film with that title alone will do: "Dune" could
    // be 1984 or 2021, and a wrong poster is worse than none.
    return titled.length === 1 ? titled[0] : undefined;
  return titled.find((r) => {
    const year = Number(r.release_date?.slice(0, 4));
    return Number.isFinite(year) && Math.abs(year - query.year!) <= 1;
  });
}

async function image(
  fetcher: typeof fetch,
  size: string,
  path: string,
  directory: string,
): Promise<string | undefined> {
  if (!imagePath.test(path)) return;
  const response = await fetcher(`${IMAGES}/${size}${path}`, {
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    return;
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARTWORK_BYTES) {
    await response.body?.cancel();
    return;
  }
  // Counted as it arrives: a missing or false length does not get past this.
  const bytes = await capped(response, MAX_ARTWORK_BYTES).catch(
    () => undefined,
  );
  if (!bytes) return;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (
    bytes.length < 1024 ||
    bytes.length > MAX_ARTWORK_BYTES ||
    (!jpeg && !png)
  )
    return;
  const file = artworkName(png ? "png" : "jpg");
  await writeFile(join(directory, file), bytes, { mode: 0o600 });
  return file;
}

/**
 * Look up pictures for films that have none from TMDB yet. Returns how many
 * films were looked at; stops early, and says so, if TMDB refuses the token.
 */
export async function lookupArtwork(
  db: Database,
  dataDir: string,
  token: string,
  options: { fetcher?: typeof fetch; limit?: number; now?: () => number } = {},
): Promise<{ looked: number; found: number; refused: boolean }> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const directory = artworkDirectory(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const films = db
    .prepare(
      `SELECT m.id,m.title,m.year FROM movies m
       WHERE EXISTS(SELECT 1 FROM source_files s WHERE s.movie_id=m.id AND s.available=1)
       AND NOT EXISTS(SELECT 1 FROM artwork a WHERE a.movie_id=m.id AND a.provider='tmdb')
       AND NOT EXISTS(SELECT 1 FROM artwork_lookups l WHERE l.movie_id=m.id AND (l.outcome='found' OR (l.outcome='error' AND l.tried_at>?) OR (l.outcome<>'error' AND l.tried_at>?)))
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(
      now() - ERROR_RETRY_MS,
      now() - RETRY_MS,
      options.limit ?? 20,
    ) as Array<{
    id: string;
    title: string;
    year: number | null;
  }>;
  let found = 0;
  const record = (id: string, outcome: string) =>
    db
      .prepare(
        "INSERT INTO artwork_lookups(movie_id,tried_at,outcome) VALUES(?,?,?) ON CONFLICT(movie_id) DO UPDATE SET tried_at=excluded.tried_at,outcome=excluded.outcome",
      )
      .run(id, now(), outcome);
  for (const film of films) {
    // An edited title is the owner's word; otherwise read the file's name.
    const queries = releaseQueries(film.title, film.year);
    if (!queries[0]!.query) {
      record(film.id, "no-title");
      continue;
    }
    let match: z.infer<typeof result> | undefined;
    let outcome: "match" | "none" | "error" | "refused" | "busy" = "none";
    for (const query of queries) {
      let response: Response;
      try {
        const params = new URLSearchParams({
          query: query.query,
          include_adult: "false",
          ...(query.year ? { year: String(query.year) } : {}),
        });
        response = await fetcher(`${API}/search/movie?${params}`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
      } catch {
        outcome = "error";
        break;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        outcome = "refused";
        break;
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Too many requests or TMDB is down: try the rest another time.
        outcome =
          response.status === 429 || response.status >= 500 ? "busy" : "error";
        break;
      }
      const body = await capped(response, MAX_SEARCH_BYTES).catch(
        () => undefined,
      );
      let data: unknown = null;
      try {
        data = body ? JSON.parse(body.toString("utf8")) : null;
      } catch {
        data = null;
      }
      const parsed = search.safeParse(data);
      match = parsed.success
        ? chooseResult(parsed.data.results, query)
        : undefined;
      if (match) {
        outcome = "match";
        break;
      }
    }
    if (outcome === "refused")
      return { looked: films.indexOf(film), found, refused: true };
    if (outcome === "error" || outcome === "busy") {
      record(film.id, "error");
      if (outcome === "busy") break;
      continue;
    }
    if (!match) {
      record(film.id, "no-match");
      continue;
    }
    const pictures: Picture[] = [];
    try {
      const poster = match.poster_path
        ? await image(fetcher, "w500", match.poster_path, directory)
        : undefined;
      if (poster)
        pictures.push({ kind: "poster", provider: "tmdb", file: poster });
      const still = match.backdrop_path
        ? await image(fetcher, "w1280", match.backdrop_path, directory)
        : undefined;
      if (still)
        pictures.push({ kind: "still", provider: "tmdb", file: still });
    } catch {
      await Promise.all(
        pictures.map((p) => rm(join(directory, p.file), { force: true })),
      );
      record(film.id, "error");
      continue;
    }
    if (!pictures.length) {
      record(film.id, "no-pictures");
      continue;
    }
    await storeArtwork(
      db,
      directory,
      film.id,
      String(match.id),
      "tmdb",
      pictures,
      now(),
    );
    record(film.id, "found");
    found++;
  }
  return { looked: films.length, found, refused: false };
}
