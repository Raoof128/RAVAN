import { afterEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../apps/worker/src/process.js";
import {
  artworkDirectory,
  sweepArtwork,
} from "../../apps/worker/src/artwork.js";
import {
  boundedRead,
  extractBookCover,
  storeBookCover,
  type ReadRange,
} from "../../apps/worker/src/book-cover.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import type {
  DriveClient,
  DriveFile,
} from "../../apps/api/src/drive/client.js";
import { openDatabase, type Database } from "../../packages/db/src/open.js";
import { migrate } from "../../packages/db/src/migrate.js";
import { pdfFixture, readingZip } from "../fixtures/reading.js";

const dirs: string[] = [];
const clean: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of clean.splice(0).reverse()) await step();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const idle = () => new AbortController().signal;
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "ravan-cover-"));
  dirs.push(dir);
  return dir;
}
/** A picture with detail in it, as PNG bytes. */
async function picture(size = "300x450") {
  const dir = await workspace();
  const path = join(dir, "picture.png");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}`,
      "-frames:v",
      "1",
      "-update",
      "1",
      path,
    ],
    idle(),
    60000,
  );
  return new Uint8Array(await readFile(path));
}
/** Bytes that are named as a picture and cannot be decoded as one. */
const decoy = new TextEncoder().encode("not a picture at all");
function reader(bytes: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const read: ReadRange = async (start, end) => {
    reads.push([start, end]);
    return bytes.subarray(start, end);
  };
  return { read, reads };
}
const dimensions = async (path: string) =>
  JSON.parse(
    await runProcess(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        path,
      ],
      idle(),
      10000,
    ),
  ).streams[0] as { width: number; height: number };
const container = (opf: string) =>
  `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
async function cover(format: "epub" | "cbz" | "pdf", book: Uint8Array) {
  const dir = await workspace();
  const { read, reads } = reader(book);
  const made = await extractBookCover(format, book.length, read, dir, idle());
  return { made, dir, reads };
}

it("takes an EPUB 3 cover named in its package, not the first picture", async () => {
  const book = await readingZip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": container("OPS/book.opf"),
    "OPS/book.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>
      <item id="logo" href="img/logo.png" media-type="image/png"/>
      <item id="front" href="img/front.png" media-type="image/png" properties="cover-image"/>
      <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="one"/></spine></package>`,
    "OPS/one.xhtml": "<html><body><p>Text</p></body></html>",
    "OPS/img/logo.png": decoy,
    "OPS/img/front.png": await picture(),
  });
  const { made, dir } = await cover("epub", book);
  expect(made).toMatchObject({ kind: "poster", provider: "cover" });
  expect(await dimensions(join(dir, made!.file))).toEqual({
    width: 480,
    height: 720,
  });
});

it("follows an EPUB 2 cover meta element to an escaped, relative path", async () => {
  const book = await readingZip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": container("OEBPS/content.opf"),
    "OEBPS/content.opf": `<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0"><opf:metadata><opf:meta content="art" name="cover"/></opf:metadata><opf:manifest>
      <opf:item id="first" href="Images/first.jpg" media-type="image/jpeg"/>
      <opf:item id="art" href="Images/Cover%20Art.png" media-type="image/png"/>
    </opf:manifest><opf:spine/></opf:package>`,
    "OEBPS/Images/first.jpg": decoy,
    "OEBPS/Images/Cover Art.png": await picture(),
  });
  expect((await cover("epub", book)).made).toBeDefined();
});

it("uses the picture on an EPUB's first page when nothing is named", async () => {
  const book = await readingZip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": container("book.opf"),
    "book.opf": `<package><manifest>
      <item id="title" href="text/title.xhtml" media-type="application/xhtml+xml"/>
      <item id="p" href="pics/plate.png" media-type="image/png"/>
    </manifest><spine><itemref idref="title"/></spine></package>`,
    "text/title.xhtml":
      '<html xmlns:xlink="http://www.w3.org/1999/xlink"><body><svg><image xlink:href="../pics/plate.png"/></svg></body></html>',
    "pics/plate.png": await picture(),
  });
  expect((await cover("epub", book)).made).toBeDefined();
});

it("makes no cover for a book without pictures, and refuses paths out of the archive", async () => {
  const plain = await readingZip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": container("book.opf"),
    "book.opf": `<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
      <item id="x" href="../../escape.png" media-type="image/png" properties="cover-image"/></manifest>
      <spine><itemref idref="one"/></spine></package>`,
    "one.xhtml":
      '<html><body><img src="https://example.test/x.png"/></body></html>',
  });
  const { made, dir } = await cover("epub", plain);
  expect(made).toBeUndefined();
  expect(await readdir(dir)).toEqual([]);
});

it("takes a manga's first page in reading order", async () => {
  const book = await readingZip({
    "10.png": decoy,
    "2.png": decoy,
    "__MACOSX/1.png": decoy,
    "1.png": await picture("600x900"),
  });
  expect((await cover("cbz", book)).made).toBeDefined();
});

it("draws the first page of a PDF from a few ranges of a large file", async () => {
  const pdf = new Uint8Array(pdfFixture(7 * 1024 * 1024));
  const { made, dir, reads } = await cover("pdf", pdf);
  expect(made).toBeDefined();
  expect(await dimensions(join(dir, made!.file))).toEqual({
    width: 480,
    height: 720,
  });
  const read = reads.reduce((n, [a, b]) => n + b - a, 0);
  expect(read).toBeLessThan(pdf.length / 4);
});

it("reads no more of a book than a cover needs", async () => {
  const read = boundedRead(async (a, b) => new Uint8Array(b - a), 100);
  await read(0, 60, idle());
  await expect(read(60, 120, idle())).rejects.toThrow(/too much/);
});

function database(dir: string) {
  const db = openDatabase(join(dir, "mov.sqlite"));
  migrate(db);
  clean.push(() => db.close());
  db.prepare(
    "INSERT INTO reading_items(id,name,format,generation,size_bytes,metadata) VALUES('book','Book.cbz','cbz',?,'10','{}')",
  ).run("a".repeat(64));
  return db;
}

it("replaces a book's cover, refuses one for a changed file, and the sweep keeps it", async () => {
  const dir = await workspace();
  const db = database(dir);
  const art = artworkDirectory(dir);
  const first = {
    kind: "poster" as const,
    provider: "cover" as const,
    file: `${"1".repeat(32)}.jpg`,
  };
  const second = {
    kind: "poster" as const,
    provider: "cover" as const,
    file: `${"2".repeat(32)}.jpg`,
  };
  await mkdir(art, { recursive: true });
  await writeFile(join(art, first.file), "first");
  await writeFile(join(art, second.file), "second");
  await storeBookCover(db, art, "book", "a".repeat(64), first);
  await storeBookCover(db, art, "book", "a".repeat(64), second);
  expect(await readdir(art)).toEqual([second.file]);
  expect(
    db.prepare("SELECT picture_id,path FROM reading_covers").get(),
  ).toEqual({ picture_id: "2".repeat(32), path: second.file });
  // The file changed while its cover was being made.
  const late = { ...first, file: `${"3".repeat(32)}.jpg` };
  await writeFile(join(art, late.file), "late");
  await expect(
    storeBookCover(db, art, "book", "b".repeat(64), late),
  ).rejects.toThrow(/Source changed/);
  expect(await readdir(art)).toEqual([second.file]);
  // An hour later the sweep removes strays, never a book's cover.
  const old = new Date(Date.now() - 2 * 3600000);
  await writeFile(join(art, `${"4".repeat(32)}.jpg`), "stray");
  await utimes(join(art, `${"4".repeat(32)}.jpg`), old, old);
  await utimes(join(art, second.file), old, old);
  expect(await sweepArtwork(db, art)).toBe(1);
  expect(await readdir(art)).toEqual([second.file]);
});

it("makes a shelf cover through the worker and serves it to the owner only", async () => {
  const dataDir = await workspace();
  const key = "ef".repeat(32);
  const origin = "https://cinema.example";
  const bytes = await readingZip({ "001.png": await picture() });
  const root: DriveFile = {
    id: "root",
    name: "Library",
    mimeType: "application/vnd.google-apps.folder",
  };
  const book: DriveFile = {
    id: "volume",
    name: "Volume.cbz",
    mimeType: "application/vnd.comicbook+zip",
    parents: ["root"],
    version: "1",
    md5Checksum: "c".repeat(32),
    size: String(bytes.length),
    capabilities: { canDownload: true },
  };
  const drive: DriveClient = {
    get: async (id) => ({ ...(id === "root" ? root : book) }),
    list: async () => ({ files: [book] }),
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
  const app = await buildApp(
    parseConfig({
      mode: "test",
      dataDir,
      minFreeBytes: 0,
      origin,
      workerKey: key,
      clientId: "client",
      clientSecret: "secret",
      ownerSubject: "owner",
      encryptionKey: "ab".repeat(32),
    }),
    {
      driveClient: drive,
      oauthProvider: {
        authorizationUrl: ({ state }) =>
          `https://accounts.google.com/auth?state=${state}`,
        exchange: async (_code, _verifier, nonce) => ({
          subject: "owner",
          nonce,
          accessToken: "private",
          refreshToken: "private",
          expiresAt: Date.now() + 3600000,
        }),
        refresh: async () => ({
          accessToken: "private",
          expiresAt: Date.now() + 3600000,
        }),
      },
      sourceFetch: async (_url, init) => {
        const range = new Headers(init?.headers).get("range")!;
        const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        return new Response(bytes.subarray(Number(a), Number(b) + 1), {
          status: 206,
          headers: { "content-range": `bytes ${a}-${b}/${bytes.length}` },
        });
      },
    },
  );
  clean.push(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const db = app.getDecorator<Database>("database");
  const login = await app.inject("/auth/google/start");
  const state = new URL(login.headers.location!).searchParams.get("state");
  await app.inject({
    url: `/auth/google/callback?code=ok&state=${state}`,
    headers: {
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    },
  });
  const session = issueSession(db, "owner");
  const headers = {
    cookie: `mov_session=${session.token}`,
    origin,
    "x-csrf-token": session.csrf,
  };
  await app.inject({
    method: "POST",
    url: "/api/library",
    headers,
    payload: { folderId: "root" },
  });
  await expect
    .poll(
      async () =>
        (await app.inject({ url: "/api/reading", headers })).json().items
          .length,
    )
    .toBe(1);
  const item = (await app.inject({ url: "/api/reading", headers })).json()
    .items[0];
  expect(item.coverUrl).toBeUndefined();
  // The book route answers the worker's key only.
  const route = `/_worker/book/volume/${item.generation}`;
  expect((await app.inject(route)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: route.replace(item.generation, "d".repeat(64)),
        headers: { authorization: `Bearer ${key}`, range: "bytes=0-9" },
      })
    ).statusCode,
  ).toBe(409);
  const workerDb = openDatabase(join(dataDir, "mov.sqlite"));
  clean.push(() => workerDb.close());
  const prepared = join(dataDir, "prepared");
  await mkdir(prepared, { recursive: true });
  const worker = new MediaWorker(workerDb, address, key, {
    directory: prepared,
    dataDir,
    production: false,
  });
  await worker.queueLibrary();
  expect(
    db
      .prepare("SELECT kind,unique_key FROM jobs WHERE kind='book-cover'")
      .all(),
  ).toEqual([
    {
      kind: "book-cover",
      unique_key: `book-cover-v1:volume:${item.generation}`,
    },
  ]);
  expect(await worker.runNextJob(idle(), "artwork")).toBe("completed");
  const listed = (await app.inject({ url: "/api/reading", headers })).json()
    .items[0];
  expect(listed.coverUrl).toMatch(/^\/api\/artwork\/[a-f0-9]{32}$/);
  const served = await app.inject({ url: listed.coverUrl, headers });
  expect(served.statusCode).toBe(200);
  expect(served.headers["content-type"]).toBe("image/jpeg");
  expect(served.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect((await app.inject(listed.coverUrl)).statusCode).toBe(401);
  // Made once: planning again queues nothing for this generation.
  await worker.queueLibrary();
  expect(
    db.prepare("SELECT count(*) n FROM jobs WHERE kind='book-cover'").get(),
  ).toEqual({ n: 1 });
});

it("reads a malformed EPUB package in linear time", async () => {
  // Many tag openings and no closing bracket: a backtracking pattern takes
  // time in the square of the size here and would hold the worker for hours.
  const book = await readingZip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": container("book.opf"),
    "book.opf": `<package><manifest>${"<item id=x ".repeat(120000)}`,
  });
  const started = performance.now();
  expect((await cover("epub", book)).made).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(2000);
}, 20000);
