import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import {
  MAX_READING_BYTES,
  type ReadingItem,
} from "../../../../packages/contracts/src/reading.js";
import { driveId } from "../drive/client.js";
import { type LibrarySync, sourceGone } from "../drive/sync.js";
import { DriveSourceReader } from "../media/source-stream.js";

export function registerReading(
  app: FastifyInstance,
  db: Database,
  library: LibrarySync,
  fetcher?: typeof fetch,
) {
  const source = new DriveSourceReader(
    app.getDecorator<() => Promise<string>>("getDriveAccessToken"),
    (id) => library.verifyReading(id),
    fetcher,
  );
  let active = 0;
  app.get("/api/reading", async (request, reply) => {
    const query = z
      .object({
        q: z.string().max(200).default(""),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const rows = db
      .prepare(
        `SELECT id,name,format,generation,size_bytes,section,fraction FROM reading_items
      WHERE available=1 AND instr(lower(name),lower(?))>0 ORDER BY name COLLATE NOCASE,id LIMIT 61 OFFSET ?`,
      )
      .all(query.data.q, query.data.offset) as Array<{
      id: string;
      name: string;
      format: ReadingItem["format"];
      generation: string;
      size_bytes: string;
      section: number;
      fraction: number;
    }>;
    return {
      items: rows.slice(0, 60).map((r): ReadingItem => ({
        id: r.id,
        name: r.name,
        title: r.name.replace(/\.(epub|pdf|cbz)$/i, "") || r.name,
        format: r.format,
        generation: r.generation,
        sizeBytes: r.size_bytes,
        position: { section: r.section, fraction: r.fraction },
      })),
      nextOffset: rows.length > 60 ? query.data.offset + 60 : null,
    };
  });
  app.put<{ Params: { id: string } }>(
    "/api/reading/:id/progress",
    async (request, reply) => {
      const body = z
        .strictObject({
          generation: z.string().regex(/^[a-f0-9]{64}$/),
          section: z.number().int().min(0).max(10000),
          fraction: z.number().min(0).max(1),
        })
        .safeParse(request.body);
      if (!driveId.safeParse(request.params.id).success || !body.success)
        return reply.code(400).send({ error: "invalid_progress" });
      const updated = db
        .prepare(
          "UPDATE reading_items SET section=?,fraction=? WHERE id=? AND generation=? AND available=1",
        )
        .run(
          body.data.section,
          body.data.fraction,
          request.params.id,
          body.data.generation,
        );
      return updated.changes
        ? reply.code(204).send()
        : reply.code(409).send({ error: "source_changed" });
    },
  );
  app.get<{ Params: { id: string }; Querystring: { generation?: string } }>(
    "/api/reading/:id/content",
    async (request, reply) => {
      if (!driveId.safeParse(request.params.id).success)
        return reply.code(400).send({ error: "invalid_book" });
      if (active >= 2) return reply.code(429).send({ error: "reader_busy" });
      active++;
      let handedOff = false;
      try {
        const ref = await library.verifyReading(request.params.id);
        if (request.query.generation !== ref.generation)
          return reply.code(409).send({ error: "source_changed" });
        const size = BigInt(ref.sizeBytes);
        if (size <= 0 || size > BigInt(MAX_READING_BYTES))
          return reply.code(413).send({ error: "book_too_large" });
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(300000),
        ]);
        const stream = Readable.from(
          (async function* () {
            for (let start = 0n; start < size; start += 4n * 1024n * 1024n) {
              const end = start + 4n * 1024n * 1024n - 1n;
              yield await source.block(
                ref,
                start,
                end < size ? end : size - 1n,
                signal,
              );
            }
          })(),
        );
        stream.once("close", () => {
          controller.abort();
          active--;
        });
        reply.raw.once("close", () => stream.destroy());
        handedOff = true;
        // Never expose untrusted book HTML as a document at the authenticated origin.
        return reply
          .header("Content-Type", "application/octet-stream")
          .header("Content-Disposition", 'attachment; filename="reading.bin"')
          .header("Content-Length", ref.sizeBytes)
          .send(stream);
      } catch (error) {
        return reply
          .code(sourceGone(error) ? 410 : 503)
          .send({ error: "reading_unavailable" });
      } finally {
        if (!handedOff) active--;
      }
    },
  );
}
