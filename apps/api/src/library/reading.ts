import {
  SOURCE_BLOCK_BYTES,
  type SourceRef,
} from "../../../../packages/contracts/src/index.js";
import { StorageBudgetExceeded } from "../media/budget.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../../../packages/db/src/open.js";
import {
  MAX_COVER_BOOK_BYTES,
  MAX_READING_BYTES,
  readingLimit,
  type ReadingFormat,
  type ReadingFolder,
  type ReadingItem,
  type ReadingList,
} from "../../../../packages/contracts/src/reading.js";
import { driveId } from "../drive/client.js";
import { type LibrarySync, sourceGone } from "../drive/sync.js";
import type { BlockCache } from "../media/cache.js";
import { parseReadingSlices, readSlices } from "./reading-slices.js";
import { folderParam, folderPlace, placeFolder, subtree } from "./folders.js";
import { sendRaw } from "../media/raw-route.js";
import {
  describePreparation,
  queueReading,
  readingPreparation,
} from "./reading-preparation.js";

/** Blocks an opened book fetches at once, beside the reader's own requests. */
export const OPEN_WARM_CONCURRENCY = 4;
/** Parallel Drive requests per book block (see `DriveSourceReader`). */
export const BOOK_BLOCK_PARTS = 4;
/**
 * Book downloads from Drive in flight at once, across readers, warming and the
 * worker. Each costs 200 quota units of 325,000 per user per minute.
 */
export const BOOK_DRIVE_IN_FLIGHT = 24;
/** Books warmed at once. Opening another cancels the oldest. */
const OPEN_WARM_BOOKS = 2;

/**
 * Fetch every missing block of a book the owner has just opened. PDF.js and
 * zip.js find out what they need one answer at a time, so a cold first page
 * waited for each 4 MiB block in turn; with the blocks already on their way,
 * its requests join fetches in flight. Reads go through the same verified,
 * bounded cache as everything else, and stop quietly when it is full.
 */
export class OpenWarmer {
  private running = new Map<string, AbortController>();
  constructor(
    private db: Database,
    private cache: Pick<BlockCache, "readSource">,
    private concurrency = OPEN_WARM_CONCURRENCY,
  ) {}
  start(ref: SourceRef): Promise<void> {
    const key = `${ref.fileId}:${ref.generation}`;
    if (this.running.has(key)) return Promise.resolve();
    if (this.running.size >= OPEN_WARM_BOOKS) {
      const [oldest, controller] = this.running.entries().next().value!;
      controller.abort();
      this.running.delete(oldest);
    }
    const controller = new AbortController();
    this.running.set(key, controller);
    return this.run(ref, controller)
      .catch(() => {})
      .finally(() => {
        if (this.running.get(key) === controller) this.running.delete(key);
      });
  }
  stop() {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }
  private async run(ref: SourceRef, controller: AbortController) {
    const size = Number(ref.sizeBytes);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_READING_BYTES)
      return;
    const count = Math.ceil(size / SOURCE_BLOCK_BYTES);
    const resident = new Set(
      (
        this.db
          .prepare(
            "SELECT block_index FROM cache_blocks WHERE source_id=? AND generation=? AND state='ready'",
          )
          .all(ref.fileId, ref.generation) as { block_index: number }[]
      ).map((row) => row.block_index),
    );
    // Header and directory first: PDF and ZIP readers start at both ends.
    const order = [
      ...new Set([0, count - 1, ...Array.from({ length: count }, (_, i) => i)]),
    ].filter((i) => !resident.has(i));
    const signal = controller.signal;
    let next = 0;
    const lane = async () => {
      while (next < order.length) {
        signal.throwIfAborted();
        const start = order[next++]! * SOURCE_BLOCK_BYTES;
        const end = Math.min(start + SOURCE_BLOCK_BYTES, size) - 1;
        let read = 0;
        for await (const chunk of this.cache.readSource(
          { ...ref, reading: "open" },
          BigInt(start),
          BigInt(end),
          AbortSignal.any([signal, AbortSignal.timeout(90000)]),
        ))
          read += chunk.length;
        if (read !== end - start + 1) throw new Error("Incomplete book block");
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, order.length) }, () =>
        lane().catch((error: unknown) => {
          // A full cache or a Drive refusal stops the rest of this book.
          controller.abort();
          throw error;
        }),
      ),
    );
  }
}

export function registerReading(
  app: FastifyInstance,
  db: Database,
  library: LibrarySync,
  cache: BlockCache,
  workerEnabled: boolean,
) {
  let active = 0;
  const warmer = new OpenWarmer(db, cache);
  app.addHook("onClose", async () => warmer.stop());
  // A book's Drive folder, as the scan recorded the file.
  const parentOf = "json_extract(r.metadata,'$.parents[0]')";
  const bookColumns = `SELECT r.id,r.name,r.format,r.generation,r.size_bytes,r.section,r.fraction,j.state AS job_state,cv.picture_id AS cover_id,
        (SELECT COALESCE(SUM(c.size_bytes),0) FROM cache_blocks c WHERE c.source_id=r.id AND c.generation=r.generation AND c.state='ready') AS cached_bytes
        FROM reading_items r LEFT JOIN jobs j ON j.unique_key='reading:'||r.id||':'||r.generation
        LEFT JOIN reading_covers cv ON cv.item_id=r.id AND cv.generation=r.generation`;
  type BookRow = {
    id: string;
    name: string;
    format: ReadingItem["format"];
    generation: string;
    size_bytes: string;
    section: number;
    fraction: number;
    job_state: string | null;
    cover_id: string | null;
    cached_bytes: number;
  };
  const book = (r: BookRow): ReadingItem => ({
    id: r.id,
    name: r.name,
    title: r.name.replace(/\.(epub|pdf|cbz)$/i, "") || r.name,
    format: r.format,
    generation: r.generation,
    sizeBytes: r.size_bytes,
    position: { section: r.section, fraction: r.fraction },
    preparation: describePreparation(
      r.cached_bytes,
      Number(r.size_bytes),
      r.job_state,
    ),
    // Made by the worker from this generation of the book.
    ...(r.cover_id ? { coverUrl: `/api/artwork/${r.cover_id}` } : {}),
  });
  /**
   * The folders inside one, as cards: how many books each holds, counting
   * the folders in it, and the cover of its first book that has one. A
   * folder with no books (a folder of films) has no card here.
   */
  function bookFolders(parent: string): ReadingFolder[] {
    const children = db
      .prepare(
        "SELECT id,name FROM library_folders WHERE parent_id=? ORDER BY name COLLATE NOCASE,id LIMIT 500",
      )
      .all(parent) as Array<{ id: string; name: string }>;
    const count = db.prepare(
      `${subtree} SELECT COUNT(*) n FROM reading_items r WHERE r.available=1 AND ${parentOf} IN (SELECT id FROM tree)`,
    );
    const cover = db.prepare(
      `${subtree} SELECT cv.picture_id id FROM reading_items r JOIN reading_covers cv ON cv.item_id=r.id AND cv.generation=r.generation AND cv.picture_id IS NOT NULL WHERE r.available=1 AND ${parentOf} IN (SELECT id FROM tree) ORDER BY r.name COLLATE NOCASE,r.id LIMIT 1`,
    );
    const cards: ReadingFolder[] = [];
    for (const child of children) {
      const books = (count.get(child.id) as { n: number }).n;
      if (!books) continue;
      const art = cover.get(child.id) as { id: string } | undefined;
      cards.push({
        id: child.id,
        name: child.name,
        books,
        ...(art ? { coverUrl: `/api/artwork/${art.id}` } : {}),
      });
    }
    return cards;
  }
  app.get("/api/reading", async (request, reply) => {
    const query = z
      .object({
        q: z.string().max(200).default(""),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        folder: folderParam,
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const { q, offset } = query.data;
    // Browsing by folder, as the films are; without a folder (or before a
    // scan has recorded the folders) every book is one shelf.
    const folder = query.data.folder
      ? placeFolder(db, query.data.folder)
      : undefined;
    if (folder === null)
      return reply.code(404).send({ error: "folder_not_found" });
    const match = "instr(lower(r.name),lower(?))>0";
    const order = "ORDER BY r.name COLLATE NOCASE,r.id LIMIT 61 OFFSET ?";
    const rows = (
      !folder
        ? db
            .prepare(`${bookColumns} WHERE r.available=1 AND ${match} ${order}`)
            .all(q, offset)
        : q
          ? // A search in a folder looks there and in the folders inside it.
            db
              .prepare(
                `${subtree} ${bookColumns} WHERE r.available=1 AND ${parentOf} IN (SELECT id FROM tree) AND ${match} ${order}`,
              )
              .all(folder.id, q, offset)
          : db
              .prepare(
                `${bookColumns} WHERE r.available=1 AND ${parentOf}=? ${order}`,
              )
              .all(folder.id, offset)
    ) as BookRow[];
    const list: ReadingList = {
      items: rows.slice(0, 60).map(book),
      nextOffset: rows.length > 60 ? offset + 60 : null,
    };
    if (folder) {
      list.folder = folderPlace(db, folder);
      if (!q && !offset) {
        list.folders = bookFolders(folder.id);
        // Books being read, wherever they are filed, lead the top.
        if (folder.parent_id === null) {
          const reading = (
            db
              .prepare(
                `${bookColumns} WHERE r.available=1 AND (r.section>0 OR r.fraction>0) ORDER BY r.name COLLATE NOCASE,r.id LIMIT 6`,
              )
              .all() as BookRow[]
          ).map(book);
          if (reading.length) list.reading = reading;
        }
      }
    }
    return list;
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
  app.route<{ Params: { id: string }; Querystring: { generation?: string } }>({
    method: ["GET", "POST"],
    url: "/api/reading/:id/preparation",
    handler: async (request, reply) => {
      const { id } = request.params;
      if (
        !driveId.safeParse(id).success ||
        !/^[a-f0-9]{64}$/.test(request.query.generation ?? "")
      )
        return reply.code(400).send({ error: "invalid_book" });
      const row = db
        .prepare(
          "SELECT size_bytes,generation,format FROM reading_items WHERE id=? AND available=1",
        )
        .get(id) as
        | { size_bytes: string; generation: string; format: ReadingFormat }
        | undefined;
      if (!row || row.generation !== request.query.generation)
        return reply.code(409).send({ error: "source_changed" });
      const size = Number(row.size_bytes);
      if (size > readingLimit(row.format) || size <= 0)
        return reply.code(413).send({ error: "book_too_large" });
      // A PDF over the whole-book limit is read in pieces only: it is never
      // prepared whole, so asking for preparation just reports what is cached.
      return request.method === "POST" &&
        workerEnabled &&
        size <= MAX_READING_BYTES
        ? queueReading(db, id, row.generation, size)
        : readingPreparation(db, id, row.generation, size);
    },
  });
  app.get<{
    Params: { id: string };
    Querystring: { generation?: string; slices?: string };
  }>("/api/reading/:id/content", async (request, reply) => {
    if (!driveId.safeParse(request.params.id).success)
      return reply.code(400).send({ error: "invalid_book" });
    if (active >= 8) return reply.code(429).send({ error: "reader_busy" });
    active++;
    try {
      const ref = await library.verifyReading(request.params.id);
      if (request.query.generation !== ref.generation)
        return reply.code(409).send({ error: "source_changed" });
      const format = (
        db
          .prepare("SELECT format FROM reading_items WHERE id=?")
          .get(ref.fileId) as { format: ReadingFormat } | undefined
      )?.format;
      if (
        !format ||
        BigInt(ref.sizeBytes) <= 0n ||
        BigInt(ref.sizeBytes) > BigInt(readingLimit(format))
      )
        return reply.code(413).send({ error: "book_too_large" });
      void warmer.start(ref);
      // Recheck Drive throughout a long stream, including when every block is warm.
      let checkedAt = Date.now();
      const authorize = async () => {
        if (Date.now() - checkedAt < 5000) return;
        const current = await library.verifyReading(ref.fileId);
        if (current.generation !== ref.generation)
          throw new Error("Source changed");
        checkedAt = Date.now();
      };
      reply
        .header("Content-Disposition", 'attachment; filename="reading.bin"')
        .header("Cache-Control", "private, no-store");
      const book = { ...ref, reading: "foreground" as const };
      if (request.query.slices !== undefined) {
        const slices = parseReadingSlices(
          request.query.slices,
          Number(ref.sizeBytes),
        );
        if (!slices || request.headers.range || request.method !== "GET")
          return reply.code(400).send({ error: "invalid_range" });
        const controller = new AbortController();
        const cancel = () => controller.abort();
        reply.raw.once("close", cancel);
        try {
          const bytes = await readSlices(
            cache,
            ref,
            slices,
            AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
          );
          await authorize();
          return reply.type("application/octet-stream").send(bytes);
        } finally {
          reply.raw.off("close", cancel);
        }
      }
      return await sendRaw(
        request,
        reply,
        book,
        cache,
        authorize,
        "application/octet-stream",
      );
    } catch (error) {
      return reply
        .code(sourceGone(error) ? 410 : 503)
        .send({ error: "reading_unavailable" });
    } finally {
      active--;
    }
  });
}

// Only the authenticated loopback worker calls this endpoint. Book bytes stay
// in the API's single cache, which also serves interactive range requests.
export async function warmReadingBlock(
  request: FastifyRequest<{
    Params: { id: string; generation: string; index: string };
  }>,
  reply: FastifyReply,
  library: LibrarySync,
  cache: BlockCache,
) {
  const { id, generation, index } = request.params;
  if (
    !driveId.safeParse(id).success ||
    !/^[a-f0-9]{64}$/.test(generation) ||
    !/^\d{1,2}$/.test(index)
  )
    return reply.code(400).send({ error: "invalid_book" });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  reply.raw.once("close", cancel);
  try {
    const ref = await library.verifyReading(id);
    const size = Number(ref.sizeBytes),
      start = Number(index) * SOURCE_BLOCK_BYTES;
    if (
      ref.generation !== generation ||
      size > MAX_READING_BYTES ||
      start >= size
    )
      return reply.code(409).send({ error: "source_changed" });
    const end = Math.min(start + SOURCE_BLOCK_BYTES, size) - 1;
    for await (const chunk of cache.readSource(
      { ...ref, reading: "background" },
      BigInt(start),
      BigInt(end),
      AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
    )) {
      controller.signal.throwIfAborted();
      if (!chunk.length) throw new Error("Empty cache block");
    }
    return { cached: true };
  } catch (error) {
    if (error instanceof StorageBudgetExceeded)
      return reply.code(507).send({ error: "cache_full" });
    return reply
      .code(sourceGone(error) ? 410 : 503)
      .send({ error: "reading_unavailable" });
  } finally {
    reply.raw.off("close", cancel);
  }
}

// Only the authenticated loopback worker calls this endpoint, to read the
// parts of a book its shelf picture is made from.
export async function sendBookToWorker(
  request: FastifyRequest<{ Params: { id: string; generation: string } }>,
  reply: FastifyReply,
  library: LibrarySync,
  cache: BlockCache,
) {
  const { id, generation } = request.params;
  if (!driveId.safeParse(id).success || !/^[a-f0-9]{64}$/.test(generation))
    return reply.code(400).send({ error: "invalid_book" });
  try {
    const ref = await library.verifyReading(id);
    // A cover reads only the parts of a book it needs, so a book over the
    // reading limit still gets one.
    if (
      ref.generation !== generation ||
      BigInt(ref.sizeBytes) <= 0n ||
      BigInt(ref.sizeBytes) > BigInt(MAX_COVER_BOOK_BYTES)
    )
      return reply.code(409).send({ error: "source_changed" });
    let checkedAt = Date.now();
    const book = { ...ref, reading: "background" as const };
    return await sendRaw(
      request,
      reply,
      book,
      cache,
      async () => {
        if (Date.now() - checkedAt < 5000) return;
        const current = await library.verifyReading(id);
        if (current.generation !== generation)
          throw new Error("Source changed");
        checkedAt = Date.now();
      },
      "application/octet-stream",
    );
  } catch (error) {
    if (error instanceof StorageBudgetExceeded)
      return reply.code(507).send({ error: "cache_full" });
    return reply
      .code(sourceGone(error) ? 410 : 503)
      .send({ error: "reading_unavailable" });
  }
}
