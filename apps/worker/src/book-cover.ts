import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  Reader,
  Uint8ArrayWriter,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js";
import type { Database } from "../../../packages/db/src/open.js";
import type { ReadingFormat } from "../../../packages/contracts/src/reading.js";
import { ARTWORK_FILE, posterFromImage, type Picture } from "./artwork.js";

/**
 * Shelf pictures for books, made from the books themselves, as films get
 * theirs: an EPUB's cover image, the first page of a CBZ, the first page of a
 * PDF drawn by PDF.js. Only the parts of the file that hold them are read, and
 * nothing leaves the server.
 */
export type ReadRange = (
  start: number,
  end: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;
/** The most of one book a cover may read: its directory, package and picture. */
export const COVER_READ_BYTES = 48 * 1024 * 1024;
const ENTRY_BYTES = 16 * 1024 * 1024;
const TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const raster = /\.(png|jpe?g|webp|gif)$/i;
/** The page drawn for a PDF cover: enough for a 480 by 720 poster. */
const PDF_PAGE = { width: 960, height: 1440 };

/** A reader that refuses to read more of a book than a cover needs. */
export function boundedRead(read: ReadRange, limit = COVER_READ_BYTES) {
  let used = 0;
  return async (start: number, end: number, signal: AbortSignal) => {
    used += Math.max(0, end - start);
    if (used > limit) throw new Error("Cover needs too much of the book");
    return read(start, end, signal);
  };
}

export async function extractBookCover(
  format: ReadingFormat,
  size: number,
  read: ReadRange,
  directory: string,
  signal: AbortSignal,
): Promise<Picture | undefined> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bounded = boundedRead(read);
  const image =
    format === "pdf"
      ? await pdfPage(size, bounded, signal)
      : await archiveImage(format, size, bounded, signal);
  if (!image) return;
  const path = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(path, image, { mode: 0o600 });
    return await posterFromImage(path, directory, signal);
  } finally {
    await rm(path, { force: true });
  }
}

class RangeReader extends Reader<null> {
  constructor(
    size: number,
    private read: ReadRange,
    private signal: AbortSignal,
  ) {
    super(null);
    this.size = size;
  }
  readUint8Array(offset: number, length: number) {
    // zip.js may ask past the end; the answer is truncated, never negative.
    const start = Math.min(offset, this.size);
    const end = Math.min(this.size, offset + Math.max(0, length));
    return this.read(start, end, this.signal);
  }
}

function safePath(path: string) {
  return (
    Boolean(path) &&
    path.length <= 1024 &&
    !/[\\\u0000-\u001f]/.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    !/^[a-z][a-z\d+.-]*:/i.test(path)
  );
}

async function archiveImage(
  format: "epub" | "cbz",
  size: number,
  read: ReadRange,
  signal: AbortSignal,
) {
  const zip = new ZipReader(new RangeReader(size, read, signal), {
    useWebWorkers: false,
    useCompressionStream: true,
  });
  try {
    const entries = new Map<string, FileEntry>();
    for await (const entry of zip.getEntriesGenerator()) {
      signal.throwIfAborted();
      if (entries.size >= MAX_ENTRIES) break;
      if (entry.directory || !safePath(entry.filename)) continue;
      entries.set(entry.filename, entry);
    }
    const take = async (path: string | undefined, limit = ENTRY_BYTES) => {
      const entry = path ? entries.get(path) : undefined;
      if (!entry || entry.encrypted || entry.uncompressedSize > limit) return;
      return entry.getData(new Uint8ArrayWriter(), { signal });
    };
    if (format === "cbz") {
      // The same order the reader turns pages in.
      const first = [...entries.keys()]
        .filter((p) => raster.test(p) && !p.startsWith("__MACOSX/"))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0];
      return take(first);
    }
    if (entries.has("META-INF/encryption.xml")) return;
    const text = async (path: string | undefined) => {
      const bytes = await take(path, TEXT_BYTES);
      return bytes && new TextDecoder().decode(bytes);
    };
    const container = await text("META-INF/container.xml");
    const opfPath =
      container && attribute(tags(container, "rootfile")[0], "full-path");
    const opf = await text(opfPath);
    if (!opf || !opfPath) return;
    const items = tags(opf, "item").map((tag) => ({
      id: attribute(tag, "id"),
      href: resolve(opfPath, attribute(tag, "href")),
      type: attribute(tag, "media-type") ?? "",
      properties: (attribute(tag, "properties") ?? "").split(/\s+/),
    }));
    const isImage = (item?: (typeof items)[number]) =>
      !!item?.href && raster.test(item.href) && entries.has(item.href);
    // EPUB 3 names its cover; EPUB 2 points at it from a meta element.
    const named = items.find(
      (item) => item.properties.includes("cover-image") && isImage(item),
    );
    if (named) return take(named.href);
    const metaId = attribute(
      tags(opf, "meta").find((tag) => attribute(tag, "name") === "cover"),
      "content",
    );
    const meta = items.find((item) => item.id === metaId);
    if (isImage(meta)) return take(meta!.href);
    const called = items.find(
      (item) => isImage(item) && /cover/i.test(`${item.id} ${item.href}`),
    );
    if (called) return take(called.href);
    // Otherwise the first picture on the first page, often a cover page.
    const firstId = attribute(tags(opf, "itemref")[0], "idref");
    const firstPage = items.find((item) => item.id === firstId)?.href;
    const page = await text(firstPage);
    if (!page || !firstPage) return;
    const source =
      attribute(tags(page, "img")[0], "src") ??
      attribute(tags(page, "image")[0], "xlink:href") ??
      attribute(tags(page, "image")[0], "href");
    const picture = resolve(firstPage, source);
    if (picture && raster.test(picture)) return take(picture);
  } finally {
    await zip.close();
  }
}

/** The most start tags read from one file, and the longest tag kept. */
const MAX_TAGS = 20000;
const MAX_TAG_LENGTH = 16 * 1024;
/**
 * Start tags with this local name, whatever their namespace prefix. A linear
 * scan from each `<` to the next `>`: a pattern run over the whole file
 * backtracks, and a malformed package with no `>` took minutes.
 */
function tags(xml: string, name: string) {
  const head = new RegExp(`^<(?:[\\w.-]{1,64}:)?${name}(?=[\\s/>])`, "i");
  const found: string[] = [];
  let at = 0;
  while (found.length < MAX_TAGS) {
    const open = xml.indexOf("<", at);
    if (open < 0) break;
    const close = xml.indexOf(">", open);
    if (close < 0) break;
    if (
      close - open < MAX_TAG_LENGTH &&
      head.test(xml.slice(open, Math.min(close + 1, open + 80)))
    )
      found.push(xml.slice(open, close + 1));
    at = close + 1;
  }
  return found;
}
function attribute(tag: string | undefined, name: string) {
  if (!tag) return;
  const escaped = name.replace(/[.:-]/g, (c) => `\\${c}`);
  const match = new RegExp(
    `\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value?.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!,
  );
}
/** A path inside the archive, from a reference in the file at `from`. */
function resolve(from: string, href: string | undefined) {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("/")) return;
  let path: string;
  try {
    path = decodeURIComponent(href.split("#")[0]!.split("?")[0]!);
  } catch {
    return;
  }
  const joined = posix.normalize(posix.join(posix.dirname(from), path));
  return safePath(joined) ? joined : undefined;
}

const pdfjsUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs"),
).href;
const assets = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);

/**
 * Runs in its own thread. PDF.js 6.5 throws into a promise nobody handles when
 * a document is destroyed while it loads (pdf.worker.mjs, `pdfManagerReady`).
 * Node ends the process for that, and it ended the whole worker service with
 * any film encode in it. Here it ends only this thread. Reads are asked of the
 * parent, which keeps the read limit and the job's own errors.
 */
const PDF_THREAD = `
const { parentPort, workerData } = require("node:worker_threads");
const waiting = new Map();
let next = 0;
const fail = (error) =>
  parentPort.postMessage({ type: "failed", message: String((error && error.message) || error) });
parentPort.on("message", (m) => {
  const entry = waiting.get(m.id);
  if (!entry) return;
  waiting.delete(m.id);
  if (m.bytes) entry.resolve(m.bytes);
  else entry.reject(new Error("Read failed"));
});
const read = (begin, end) =>
  new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    parentPort.postMessage({ type: "read", id, begin, end });
  });
(async () => {
  const { getDocument, PDFDataRangeTransport } = await import(workerData.pdfjs);
  const { size, assets, width, height } = workerData;
  const transport = new PDFDataRangeTransport(size, await read(0, Math.min(size, 262144)));
  transport.requestDataRange = (begin, end) => {
    read(begin, end).then((bytes) => {
      try {
        transport.onDataRange(begin, bytes);
      } catch {
        // An answer PDF.js no longer waits for.
      }
    }, fail);
  };
  const doc = await getDocument({
    range: transport,
    rangeChunkSize: 65536,
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    maxImageSize: 20000000,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    cMapUrl: assets + "/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: assets + "/standard_fonts/",
    wasmUrl: assets + "/wasm/",
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(4, width / natural.width, height / natural.height);
  const viewport = page.getViewport({ scale });
  const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
  const { canvas, context } = doc.canvasFactory.create(w, h);
  // A page without a background is transparent; paper is white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, w, h);
  await page.render({ canvasContext: context, viewport, canvas: null }).promise;
  const png = await canvas.encode("png");
  parentPort.postMessage({ type: "done", png });
})().catch(fail);
`;

async function pdfPage(size: number, read: ReadRange, signal: AbortSignal) {
  signal.throwIfAborted();
  // PDF.js for Node draws with @napi-rs/canvas (an optional dependency of
  // pdfjs-dist). A server without it makes no PDF covers rather than failing.
  const thread = new Worker(PDF_THREAD, {
    eval: true,
    workerData: {
      pdfjs: pdfjsUrl,
      assets,
      size,
      width: PDF_PAGE.width,
      height: PDF_PAGE.height,
    },
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    stdout: true,
    stderr: true,
  });
  thread.stdout.resume();
  thread.stderr.resume();
  let stop = () => {};
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      stop = () => reject(signal.reason ?? new Error("Cancelled"));
      signal.addEventListener("abort", stop, { once: true });
      thread.on(
        "message",
        (m: {
          type: string;
          id?: number;
          begin?: number;
          end?: number;
          png?: Uint8Array;
          message?: string;
        }) => {
          if (m.type === "read")
            // A failed read ends the drawing with that read's own error.
            read(m.begin!, m.end!, signal).then(
              (bytes) => thread.postMessage({ id: m.id, bytes }),
              reject,
            );
          else if (m.type === "done") resolve(new Uint8Array(m.png!));
          else reject(new Error(m.message ?? "PDF page could not be drawn"));
        },
      );
      thread.once("error", reject);
      thread.once("exit", (code) =>
        reject(new Error(`PDF drawing ended (${code})`)),
      );
    });
  } finally {
    signal.removeEventListener("abort", stop);
    await thread.terminate();
  }
}

/**
 * Record a book's cover, or that it has none, for this generation. The old
 * picture's file is removed once the new row is in place; if the book changed
 * meanwhile, the new file is removed instead.
 */
export async function storeBookCover(
  db: Database,
  directory: string,
  itemId: string,
  generation: string,
  picture: Picture | undefined,
  now = Date.now(),
) {
  let old: string | undefined;
  try {
    old = db
      .transaction(() => {
        const current = db
          .prepare(
            "SELECT 1 FROM reading_items WHERE id=? AND generation=? AND available=1",
          )
          .get(itemId, generation);
        if (!current) throw new Error("Source changed");
        const previous = db
          .prepare("SELECT path FROM reading_covers WHERE item_id=?")
          .get(itemId) as { path: string | null } | undefined;
        db.prepare(
          `INSERT INTO reading_covers(item_id,generation,picture_id,path,created_at) VALUES(?,?,?,?,?)
         ON CONFLICT(item_id) DO UPDATE SET generation=excluded.generation,picture_id=excluded.picture_id,path=excluded.path,created_at=excluded.created_at`,
        ).run(
          itemId,
          generation,
          picture?.file.slice(0, 32) ?? null,
          picture?.file ?? null,
          now,
        );
        return previous?.path ?? undefined;
      })
      .immediate();
  } catch (error) {
    if (picture) await rm(join(directory, picture.file), { force: true });
    throw error;
  }
  if (old && old !== picture?.file && ARTWORK_FILE.test(old))
    await rm(join(directory, old), { force: true });
}
