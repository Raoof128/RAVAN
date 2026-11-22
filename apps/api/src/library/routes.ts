import type { Probe } from "../../../worker/src/probe.js";
import { textSubtitles } from "../../../worker/src/compatibility.js";
import { artworkDirectory, readArtwork } from "../../../worker/src/artwork.js";
import {
  audioLabel,
  trackLanguage,
  trackName,
} from "../../../worker/src/tracks.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import {
  idSchema,
  metadataSchema,
  preferencesSchema,
} from "../../../../packages/contracts/src/schemas.js";
import type {
  EpisodeInfo,
  FolderCard,
  MovieCard,
  MovieDetail,
  MovieList,
} from "../../../../packages/contracts/src/index.js";
import {
  compareEpisodes,
  parseEpisode,
} from "../../../../packages/contracts/src/episodes.js";
import {
  folderParam,
  folderPlace,
  placeFolder,
  subtree,
  type FolderRow,
} from "./folders.js";
type MovieRow = {
  id: string;
  title: string;
  year: number | null;
  description: string;
  resume_ms: number;
  available: number;
  saved: number;
  poster_id: string | null;
  poster_provider: string | null;
  still_id: string | null;
};
// The best picture of each kind: from TMDB, then the film's own cover, then a
// frame of the film.
const best = (kind: string, column: string) =>
  `(SELECT a.${column} FROM artwork a WHERE a.movie_id=m.id AND a.kind='${kind}' ORDER BY CASE a.provider WHEN 'tmdb' THEN 0 WHEN 'cover' THEN 1 ELSE 2 END LIMIT 1)`;
const selection = `SELECT m.*,COALESCE((SELECT CASE WHEN ended=1 THEN 0 ELSE position_ms END FROM progress p WHERE p.movie_id=m.id),0) resume_ms,EXISTS(SELECT 1 FROM source_files s WHERE s.movie_id=m.id AND s.available=1) available,EXISTS(SELECT 1 FROM watchlist w WHERE w.movie_id=m.id) saved,${best("poster", "id")} poster_id,${best("poster", "provider")} poster_provider,${best("still", "id")} still_id FROM movies m`;
function card(row: MovieRow): MovieCard {
  return {
    id: row.id,
    title: row.title,
    ...(row.year !== null ? { year: row.year } : {}),
    resumeMs: row.resume_ms,
    available: Boolean(row.available),
    ...(row.poster_id
      ? {
          posterUrl: `/api/artwork/${row.poster_id}`,
          // A frame of the film has no title on it; the card sets one.
          ...(row.poster_provider === "frame" ? { posterTitled: true } : {}),
        }
      : {}),
    ...(row.still_id ? { stillUrl: `/api/artwork/${row.still_id}` } : {}),
  };
}
export function registerCatalogue(
  app: FastifyInstance,
  db: Database,
  dataDir: string,
) {
  /**
   * Where a film named as an episode stands in its Drive folder, and the one
   * after it. The file names decide: titles can be edited, numbers cannot.
   */
  function episodeOf(id: string): EpisodeInfo | undefined {
    const source = db
      .prepare(
        "SELECT name,parent_id FROM source_files WHERE movie_id=? AND available=1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1",
      )
      .get(id) as { name: string; parent_id: string } | undefined;
    const own = source && parseEpisode(source.name);
    if (!source || !own) return;
    const films = new Map<
      string,
      { id: string; name: string; season?: number; episode: number }
    >();
    for (const sibling of db
      .prepare(
        "SELECT movie_id id,name FROM source_files WHERE parent_id=? AND available=1 ORDER BY id",
      )
      .all(source.parent_id) as Array<{ id: string; name: string }>) {
      const number = parseEpisode(sibling.name);
      if (number && !films.has(sibling.id))
        films.set(sibling.id, { ...sibling, ...number });
    }
    const order = [...films.values()].sort(compareEpisodes);
    const at = order.findIndex((film) => film.id === id);
    const after = order[at + 1];
    const nextRow = after
      ? (db.prepare(`${selection} WHERE m.id=?`).get(after.id) as
          MovieRow | undefined)
      : undefined;
    const folder = db
      .prepare("SELECT name FROM library_folders WHERE id=?")
      .get(source.parent_id) as { name: string } | undefined;
    return {
      ...own,
      index: at + 1,
      count: order.length,
      folder: { id: source.parent_id, name: folder?.name ?? "" },
      ...(after && nextRow
        ? {
            next: {
              ...card(nextRow),
              ...(after.season !== undefined ? { season: after.season } : {}),
              episode: after.episode,
            },
          }
        : {}),
    };
  }
  function detail(id: string): MovieDetail | undefined {
    const row = db.prepare(`${selection} WHERE m.id=?`).get(id) as
      MovieRow | undefined;
    if (!row) return;
    const episode = episodeOf(id);
    const editions = db
      .prepare(
        "SELECT e.id,e.label,e.state,e.source_id sourceId,COALESCE(s.available,0) available FROM editions e LEFT JOIN source_files s ON s.id=e.source_id WHERE e.movie_id=? ORDER BY e.id",
      )
      .all(id) as Array<{
      id: string;
      label: string;
      state: string;
      sourceId: string;
      available: number;
    }>;
    const probeRow = db
      .prepare(
        "SELECT t.metadata FROM tracks t JOIN editions e ON e.id=t.edition_id WHERE e.movie_id=? AND t.kind='probe' LIMIT 1",
      )
      .get(id) as { metadata: string } | undefined;
    const probe = probeRow
      ? (JSON.parse(probeRow.metadata) as { probe: Probe }).probe
      : undefined;
    return {
      audioTracks: probe?.audio.map((a, index) => ({
        index,
        language: trackLanguage(a.language),
        label: audioLabel(a, index),
      })),
      subtitleTracks: probe?.subtitles.map((s, index) => ({
        language: trackLanguage(s.language),
        label: trackName(s, index).replace(/^Audio /, "Subtitles "),
        text: textSubtitles.has(s.codec),
      })),
      ...card(row),
      ...(episode ? { episode } : {}),
      description: row.description,
      saved: Boolean(row.saved),
      editions: editions.map((e) => ({
        ...e,
        available: Boolean(e.available),
      })),
      tracks: db
        .prepare(
          "SELECT t.id,t.kind,t.codec,t.language FROM tracks t JOIN editions e ON e.id=t.edition_id WHERE e.movie_id=? AND t.kind<>'probe'",
        )
        .all(id) as MovieDetail["tracks"],
    };
  }
  const place = (folder: string) => placeFolder(db, folder);
  function folderCards(parent: string): FolderCard[] {
    const children = db
      .prepare(
        "SELECT id,name FROM library_folders WHERE parent_id=? ORDER BY name COLLATE NOCASE,id LIMIT 500",
      )
      .all(parent) as Array<{ id: string; name: string }>;
    const count = db.prepare(
      `${subtree} SELECT COUNT(DISTINCT s.movie_id) n FROM source_files s JOIN tree ON s.parent_id=tree.id WHERE s.available=1`,
    );
    // The folder's picture is the first of its films, by title, that has one.
    const cover = db.prepare(
      `${subtree} SELECT a.id,a.provider FROM source_files s JOIN tree ON s.parent_id=tree.id JOIN movies m ON m.id=s.movie_id JOIN artwork a ON a.movie_id=m.id AND a.kind='poster' WHERE s.available=1 ORDER BY m.title COLLATE NOCASE,m.id,CASE a.provider WHEN 'tmdb' THEN 0 WHEN 'cover' THEN 1 ELSE 2 END LIMIT 1`,
    );
    const cards: FolderCard[] = [];
    for (const child of children) {
      const films = (count.get(child.id) as { n: number }).n;
      // A folder of subtitles or extras with no film in it is not shown.
      if (!films) continue;
      const art = cover.get(child.id) as
        { id: string; provider: string } | undefined;
      cards.push({
        id: child.id,
        name: child.name,
        films,
        ...(art
          ? {
              posterUrl: `/api/artwork/${art.id}`,
              ...(art.provider === "frame" ? { posterTitled: true } : {}),
            }
          : {}),
      });
    }
    return cards;
  }
  app.get("/api/movies", async (request, reply) => {
    const query = z
      .strictObject({
        q: z.string().max(200).default(""),
        cursor: z.string().max(1200).optional(),
        saved: z.enum(["true", "false"]).optional(),
        folder: folderParam,
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const browsing = query.data.folder ? place(query.data.folder) : undefined;
    if (browsing === null)
      return reply.code(404).send({ error: "folder_not_found" });
    if (browsing) return browse(browsing, query.data, reply);
    let after = "";
    if (query.data.cursor) {
      try {
        after = Buffer.from(query.data.cursor, "base64url").toString("utf8");
        if (
          Buffer.from(after).toString("base64url") !== query.data.cursor ||
          !idSchema.safeParse(after).success
        )
          throw new Error();
      } catch {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
    }
    const escaped = query.data.q.replace(/[\\%_]/g, "\\$&");
    const rows = db
      .prepare(
        `${selection} WHERE m.id>? AND m.title LIKE ? ESCAPE '\\' ${query.data.saved === "true" ? "AND EXISTS(SELECT 1 FROM watchlist w WHERE w.movie_id=m.id)" : ""} ORDER BY m.id LIMIT 41`,
      )
      .all(after, `%${escaped}%`) as MovieRow[];
    const more = rows.length > 40;
    const items = rows.slice(0, 40).map(card);
    return {
      items,
      nextCursor: more
        ? Buffer.from(items.at(-1)!.id).toString("base64url")
        : null,
    };
  });
  /**
   * One folder: the folders in it, then its films by title. Films are paged;
   * the folders, and the films in progress at the top, come with the first page.
   */
  function browse(
    folder: FolderRow,
    query: { q: string; cursor?: string; saved?: string },
    reply: FastifyReply,
  ) {
    let after: [string, string] | undefined;
    if (query.cursor) {
      try {
        const text = Buffer.from(query.cursor, "base64url").toString("utf8");
        const value = z
          .tuple([z.string().max(600), idSchema])
          .parse(JSON.parse(text));
        if (Buffer.from(text).toString("base64url") !== query.cursor)
          throw new Error();
        after = value;
      } catch {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
    }
    const escaped = query.q.replace(/[\\%_]/g, "\\$&");
    const rows = db
      .prepare(
        `${selection} WHERE EXISTS(SELECT 1 FROM source_files s WHERE s.movie_id=m.id AND s.parent_id=?) AND m.title LIKE ? ESCAPE '\\' ${query.saved === "true" ? "AND EXISTS(SELECT 1 FROM watchlist w WHERE w.movie_id=m.id)" : ""} ${after ? "AND (m.title>? COLLATE NOCASE OR (m.title=? COLLATE NOCASE AND m.id>?))" : ""} ORDER BY m.title COLLATE NOCASE,m.id LIMIT 41`,
      )
      .all(
        folder.id,
        `%${escaped}%`,
        ...(after ? [after[0], after[0], after[1]] : []),
      ) as MovieRow[];
    const more = rows.length > 40;
    const items = rows.slice(0, 40).map(card);
    const last = items.at(-1);
    const top = folder.parent_id === null;
    const list: MovieList = {
      items,
      nextCursor:
        more && last
          ? Buffer.from(JSON.stringify([last.title, last.id])).toString(
              "base64url",
            )
          : null,
      folder: folderPlace(db, folder),
    };
    if (!query.cursor && !query.q) {
      list.folders = folderCards(folder.id);
      // Films being watched, wherever they are filed, lead the top of the library.
      if (top)
        list.resume = (
          db
            .prepare(
              `${selection} JOIN progress p ON p.movie_id=m.id WHERE p.ended=0 AND p.position_ms>0 AND EXISTS(SELECT 1 FROM source_files s WHERE s.movie_id=m.id AND s.available=1) ORDER BY p.updated_at DESC LIMIT 5`,
            )
            .all() as MovieRow[]
        ).map(card);
    }
    return list;
  }
  app.get<{ Params: { id: string } }>(
    "/api/movies/:id",
    async (request, reply) =>
      detail(request.params.id) ??
      reply.code(404).send({ error: "movie_not_found" }),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/movies/:id",
    async (request, reply) => {
      const association = z
        .strictObject({ associateSourceId: idSchema })
        .safeParse(request.body);
      if (association.success) {
        if (
          !db
            .prepare("SELECT 1 FROM movies WHERE id=?")
            .get(request.params.id) ||
          !db
            .prepare("SELECT 1 FROM source_files WHERE id=?")
            .get(association.data.associateSourceId)
        )
          return reply.code(404).send({ error: "movie_not_found" });
        db.transaction(() => {
          db.prepare(
            "UPDATE playback_sessions SET revoked_at=? WHERE source_id=? AND revoked_at IS NULL",
          ).run(Date.now(), association.data.associateSourceId);
          db.prepare("UPDATE source_files SET movie_id=? WHERE id=?").run(
            request.params.id,
            association.data.associateSourceId,
          );
          db.prepare("UPDATE editions SET movie_id=? WHERE source_id=?").run(
            request.params.id,
            association.data.associateSourceId,
          );
        })();
        return detail(request.params.id);
      }
      const body = metadataSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_metadata" });
      const changed = db
        .prepare(
          "UPDATE movies SET title=?,description=?,year=?,updated_at=?,title_edited=1 WHERE id=?",
        )
        .run(
          body.data.title,
          body.data.description ?? "",
          body.data.year ?? null,
          Date.now(),
          request.params.id,
        );
      // A corrected title or year deserves another look for a poster.
      db.prepare(
        "DELETE FROM artwork_lookups WHERE movie_id=? AND outcome<>'found'",
      ).run(request.params.id);
      if (!changed.changes)
        return reply.code(404).send({ error: "movie_not_found" });
      return detail(request.params.id);
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/watchlist/:id",
    async (request, reply) => {
      const body = z
        .strictObject({ saved: z.boolean() })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (!db.prepare("SELECT 1 FROM movies WHERE id=?").get(request.params.id))
        return reply.code(404).send({ error: "movie_not_found" });
      if (body.data.saved)
        db.prepare("INSERT OR IGNORE INTO watchlist VALUES(?,?)").run(
          request.params.id,
          Date.now(),
        );
      else
        db.prepare("DELETE FROM watchlist WHERE movie_id=?").run(
          request.params.id,
        );
      return reply.code(204).send();
    },
  );
  app.get("/api/preferences", async () => {
    const row = db.prepare("SELECT data FROM preferences WHERE id=1").get() as
      { data: string } | undefined;
    return preferencesSchema.parse(row ? JSON.parse(row.data) : {});
  });
  app.put("/api/preferences", async (request, reply) => {
    const body = preferencesSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_preferences" });
    db.prepare(
      "INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(JSON.stringify(body.data));
    return body.data;
  });
  // Pictures made by the worker from the films and books, or fetched by this server
  // when TMDB is configured. Served only by their random id, only to the owner
  // and paired screens, and never from a URL a client supplies.
  app.get<{ Params: { id: string } }>(
    "/api/artwork/:id",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const id = request.params.id;
      const row = /^[a-f0-9]{32}$/.test(id)
        ? (db
            .prepare(
              "SELECT path FROM artwork WHERE id=? UNION ALL SELECT path FROM reading_covers WHERE picture_id=? AND path IS NOT NULL LIMIT 1",
            )
            .get(id, id) as { path: string } | undefined)
        : undefined;
      const bytes = row
        ? await readArtwork(artworkDirectory(dataDir), row.path).catch(
            () => undefined,
          )
        : undefined;
      if (!row || !bytes)
        return reply.code(404).send({ error: "artwork_unavailable" });
      return (
        reply
          .type(row.path.endsWith(".png") ? "image/png" : "image/jpeg")
          // A picture's id changes whenever the picture does.
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .send(bytes)
      );
    },
  );
}
