// PDFs open in pieces, so they may be larger than EPUB and CBZ books, which
// the reader holds whole. Production, 22 November 2026: 30 of 42 Berserk
// volumes are 100 to 347 MB and could not be opened under a 100 MB limit.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import type {
  DriveClient,
  DriveFile,
} from "../../apps/api/src/drive/client.js";
import type { Database } from "../../packages/db/src/open.js";
import {
  MAX_PDF_READING_BYTES,
  MAX_READING_BYTES,
  readingLimit,
} from "../../packages/contracts/src/reading.js";
import { virtualPdf } from "../fixtures/reading.js";

const clean: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of clean.splice(0).reverse()) await step();
});

it("sets the reading limit by format: PDFs read in pieces may be larger", () => {
  expect(readingLimit("pdf")).toBe(MAX_PDF_READING_BYTES);
  expect(MAX_PDF_READING_BYTES).toBe(512 * 1024 * 1024);
  expect(readingLimit("epub")).toBe(MAX_READING_BYTES);
  expect(readingLimit("cbz")).toBe(MAX_READING_BYTES);
});

it("opens a 150 MB PDF in pieces and prepares none of it whole; refuses a big EPUB and a 600 MB PDF", async () => {
  const MB = 1024 * 1024;
  const pdfSize = 150 * MB;
  const pdfAt = virtualPdf(pdfSize);
  const dir = await mkdtemp(join(tmpdir(), "ravan-large-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const origin = "https://cinema.example";
  const file = (
    id: string,
    name: string,
    mimeType: string,
    size: number,
  ): DriveFile => ({
    id,
    name,
    mimeType,
    parents: ["root"],
    version: "1",
    md5Checksum: id.padEnd(32, "0").slice(0, 32),
    size: String(size),
    capabilities: { canDownload: true },
  });
  const files = [
    file("bigpdf", "Berserk - Volume 02.pdf", "application/pdf", pdfSize),
    file("bigepub", "Long novel.epub", "application/epub+zip", 150 * MB),
    file("hugepdf", "Omnibus.pdf", "application/pdf", 600 * MB),
  ];
  const root: DriveFile = {
    id: "root",
    name: "Library",
    mimeType: "application/vnd.google-apps.folder",
  };
  const drive: DriveClient = {
    get: async (id) => ({
      ...(id === "root" ? root : files.find((f) => f.id === id)!),
    }),
    list: async () => ({ files }),
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
  const app = await buildApp(
    parseConfig({
      mode: "test",
      dataDir: dir,
      minFreeBytes: 0,
      origin,
      workerKey: "ef".repeat(32),
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
        return new Response(pdfAt(Number(a), Number(b) + 1), {
          status: 206,
          headers: { "content-range": `bytes ${a}-${b}/${pdfSize}` },
        });
      },
    },
  );
  clean.push(() => app.close());
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
    .toBe(3);
  const items = (await app.inject({ url: "/api/reading", headers })).json()
    .items as Array<{ id: string; generation: string }>;
  const generation = (id: string) =>
    items.find((item) => item.id === id)!.generation;
  const content = (id: string, range: string) =>
    app.inject({
      url: `/api/reading/${id}/content?generation=${generation(id)}`,
      headers: { ...headers, range },
    });

  // The big PDF: its first bytes and its last, as PDF.js asks for them.
  const start = await content("bigpdf", "bytes=0-1023");
  expect(start.statusCode).toBe(206);
  expect(start.rawPayload.subarray(0, 8).toString()).toBe("%PDF-1.4");
  const end = await content("bigpdf", `bytes=${pdfSize - 1024}-${pdfSize - 1}`);
  expect(end.statusCode).toBe(206);
  expect(end.rawPayload.toString("latin1")).toContain("%%EOF");
  // It is read where the reader reads, never prepared whole in the
  // background: no reading job, even when the reader asks for one.
  const preparation = `/api/reading/bigpdf/preparation?generation=${generation("bigpdf")}`;
  const asked = await app.inject({
    method: "POST",
    url: preparation,
    headers,
  });
  expect(asked.statusCode).toBe(200);
  expect(asked.json().state).toBe("on-demand");
  expect(
    db.prepare("SELECT count(*) n FROM jobs WHERE kind='reading'").get(),
  ).toEqual({ n: 0 });

  // An EPUB is held whole by the reader: still 100 MB at most.
  expect((await content("bigepub", "bytes=0-1023")).statusCode).toBe(413);
  expect(
    (
      await app.inject({
        url: `/api/reading/bigepub/preparation?generation=${generation("bigepub")}`,
        headers,
      })
    ).statusCode,
  ).toBe(413);
  // And a PDF over 512 MB is refused.
  expect((await content("hugepdf", "bytes=0-1023")).statusCode).toBe(413);
});
