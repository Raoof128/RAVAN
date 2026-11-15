import type { Probe } from "../../../worker/src/probe.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import {
  idSchema,
  metadataSchema,
  preferencesSchema,
} from "../../../../packages/contracts/src/schemas.js";
import type {
  MovieCard,
  MovieDetail,
} from "../../../../packages/contracts/src/index.js";
type MovieRow = {
  id: string;
  title: string;
  year: number | null;
  description: string;
  resume_ms: number;
  available: number;
  saved: number;
};
const selection = `SELECT m.*,COALESCE((SELECT CASE WHEN ended=1 THEN 0 ELSE position_ms END FROM progress p WHERE p.movie_id=m.id),0) resume_ms,EXISTS(SELECT 1 FROM source_files s WHERE s.movie_id=m.id AND s.available=1) available,EXISTS(SELECT 1 FROM watchlist w WHERE w.movie_id=m.id) saved FROM movies m`;
function card(row: MovieRow): MovieCard {
  return {
    id: row.id,
    title: row.title,
    ...(row.year !== null ? { year: row.year } : {}),
    resumeMs: row.resume_ms,
    available: Boolean(row.available),
  };
}
export function registerCatalogue(app: FastifyInstance, db: Database) {
  function detail(id: string): MovieDetail | undefined {
    const row = db.prepare(`${selection} WHERE m.id=?`).get(id) as
      MovieRow | undefined;
    if (!row) return;
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
        language: a.language ?? "und",
        label:
          a.title ??
          `${a.language ?? "Audio"} · ${a.codec} · ${a.channels} channels`,
      })),
      ...card(row),
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
  app.get("/api/movies", async (request, reply) => {
    const query = z
      .strictObject({
        q: z.string().max(200).default(""),
        cursor: z.string().max(300).optional(),
        saved: z.enum(["true", "false"]).optional(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
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
          "UPDATE movies SET title=?,description=?,year=?,updated_at=? WHERE id=?",
        )
        .run(
          body.data.title,
          body.data.description ?? "",
          body.data.year ?? null,
          Date.now(),
          request.params.id,
        );
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
  // Artwork enrichment is optional and disabled. A missing image is a local
  // typographic poster in the client; no user URL is fetched by the server.
  app.get("/api/artwork/:id", async (_request, reply) =>
    reply.code(404).send({ error: "artwork_unavailable" }),
  );
}
