import cookiePlugin from "@fastify/cookie";
import Fastify from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { sessionFixture } from "../fixtures/session-harness.js";
import { issueSession, hash } from "../../apps/api/src/auth/sessions.js";
import { PairingService } from "../../apps/api/src/sessions/pairing.js";
import { registerReading } from "../../apps/api/src/library/reading.js";
import { BlockCache } from "../../apps/api/src/media/cache.js";
import { LibrarySync } from "../../apps/api/src/drive/sync.js";
import { type DriveFile } from "../../apps/api/src/drive/client.js";

const origin = "https://cinema.example";
const generation = "d".repeat(64);
const exchange = { method: "POST" as const, url: "/api/reading/session" };

async function fixture() {
  const h = await sessionFixture({
    origin,
    encryptionKey: "ab".repeat(32),
    ownerSubject: "owner",
    clientSecret: "fixture-secret",
    clientId: "fixture-client",
  });
  const owner = issueSession(h.db, "owner");
  const ownerHeaders = {
    cookie: "mov_session=" + owner.token,
    origin,
    "x-csrf-token": owner.csrf,
  };
  const pairing = new PairingService(h.db, Buffer.alloc(32, 0xab));
  async function pair(reading?: boolean) {
    const pending = pairing.create("Fixture iPhone");
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/pairing/approve",
          headers: ownerHeaders,
          payload: { code: pending.code, reading },
        })
      ).statusCode,
    ).toBe(204);
    const device = pairing.poll(pending.id, pending.pollSecret);
    if (device.state !== "approved") throw Error("Pairing fixture failed");
    const headers = { authorization: "Bearer " + device.credential };
    return {
      device,
      headers,
      ack: () => pairing.ack(pending.id, device.credential),
    };
  }
  async function open(headers: { authorization: string }) {
    const response = await h.app.inject({ ...exchange, headers });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.cookies).toHaveLength(1);
    const issued = response.cookies[0]!;
    expect(issued).toMatchObject({
      name: "ravan_reader",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/api",
      maxAge: 1800,
    });
    expect(issued.domain).toBeUndefined();
    expect(issued.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.value).not.toBe(headers.authorization.slice(7));
    const cookie = "ravan_reader=" + issued.value;
    const session = (
      await h.app.inject({ url: "/api/session", headers: { cookie } })
    ).json();
    expect(session).toEqual({
      authenticated: true,
      configured: true,
      readerOnly: true,
      csrfToken: expect.any(String),
    });
    return { cookie, origin, "x-csrf-token": session.csrfToken as string };
  }
  return { ...h, ownerHeaders, pair, open };
}

it("exchanges only an acknowledged, reader-approved device and limits its browser to books", async () => {
  const h = await fixture();
  const legacy = await h.pair();
  legacy.ack();
  const iphone = await h.pair(true);
  expect(
    (await h.app.inject("/api/capabilities")).json().features.readingRoom,
  ).toBe(true);
  expect((await h.app.inject(exchange)).statusCode).toBe(401);
  for (const headers of [legacy.headers, iphone.headers, h.ownerHeaders])
    expect((await h.app.inject({ ...exchange, headers })).statusCode).toBe(403);
  iphone.ack();
  expect(
    (
      await h.app.inject({ url: "/api/session", headers: iphone.headers })
    ).json().permissions,
  ).toEqual(["reading:read"]);
  expect(
    (await h.app.inject({ url: "/api/reading", headers: iphone.headers }))
      .statusCode,
  ).toBe(403);
  const reader = await h.open(iphone.headers);
  for (const url of [
    "/api/movies",
    "/api/devices",
    "/api/library",
    "/api/preferences",
    "/api/continue-watching",
  ])
    expect((await h.app.inject({ url, headers: reader })).statusCode).toBe(403);
  for (const url of [
    "/api/logout",
    "/api/pairing",
    "/api/pairing/approve",
    "/api/reading/book/preparation",
    exchange.url,
  ])
    expect(
      (await h.app.inject({ method: "POST", url, headers: reader })).statusCode,
    ).toBe(403);
  expect(
    (await h.app.inject({ url: "/api/movies", headers: h.ownerHeaders }))
      .statusCode,
  ).toBe(200);
  h.db
    .prepare(
      "INSERT INTO reading_items(id,name,format,generation,size_bytes,metadata) VALUES('book','Test.epub','epub',?,'100','{}')",
    )
    .run(generation);
  const list = await h.app.inject({
    url: "/api/reading?folder=root",
    headers: reader,
  });
  expect(list.json().items[0].id).toBe("book");
  const write = {
    method: "PUT" as const,
    url: "/api/reading/book/progress",
    payload: { generation, section: 3, fraction: 0.5 },
  };
  for (const headers of [
    { cookie: reader.cookie },
    { ...reader, origin: "https://elsewhere.example" },
    { ...reader, "x-csrf-token": "wrong" },
  ])
    expect((await h.app.inject({ ...write, headers })).statusCode).toBe(403);
  expect(
    (
      await h.app.inject({
        ...write,
        headers: reader,
        payload: { ...write.payload, generation: "a".repeat(64) },
      })
    ).statusCode,
  ).toBe(409);
  expect((await h.app.inject({ ...write, headers: reader })).statusCode).toBe(
    204,
  );
  expect(
    (
      await h.app.inject({ url: "/api/reading", headers: h.ownerHeaders })
    ).json().items[0].position,
  ).toEqual({ section: 3, fraction: 0.5 });
  const bookArt = "a".repeat(32),
    filmArt = "b".repeat(32);
  const directory = join(dirname(h.db.name), "artwork");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, bookArt + ".jpg"), "fixture book picture");
  await writeFile(join(directory, filmArt + ".jpg"), "fixture film picture");
  h.db
    .prepare("INSERT INTO reading_covers VALUES('book',?,?,?,0)")
    .run(generation, bookArt, bookArt + ".jpg");
  h.db
    .prepare(
      "INSERT INTO artwork(id,movie_id,path,provider) VALUES(?,'m',?,'cover')",
    )
    .run(filmArt, filmArt + ".jpg");
  const cover = (id: string, headers = reader) =>
    h.app.inject({ url: "/api/artwork/" + id, headers });
  const current = await cover(bookArt);
  expect(current.body).toBe("fixture book picture");
  expect(current.headers["cache-control"]).toContain("no-store");
  expect((await cover(filmArt)).statusCode).toBe(404);
  expect((await cover(filmArt, h.ownerHeaders)).body).toBe(
    "fixture film picture",
  );
  h.db.prepare("UPDATE reading_items SET generation='changed'").run();
  expect((await cover(bookArt)).statusCode).toBe(404);
});

it("renews across in-flight requests, expires credentials, and invalidates every cookie on device or grant removal", async () => {
  const h = await fixture();
  const a = await h.pair(true),
    b = await h.pair(true);
  a.ack();
  b.ack();
  const first = await h.open(a.headers),
    next = await h.open(a.headers),
    other = await h.open(b.headers);
  expect(first.cookie).not.toBe(next.cookie);
  expect(first["x-csrf-token"]).toBe(next["x-csrf-token"]);
  expect(other["x-csrf-token"]).not.toBe(first["x-csrf-token"]);
  const access = async (cookie: string) =>
    (await h.app.inject({ url: "/api/reading", headers: { cookie } }))
      .statusCode;
  expect(await access(first.cookie)).toBe(200);
  const hashOf = (cookie: string) => hash(cookie.slice("ravan_reader=".length));
  const previous = h.db
    .prepare("SELECT expires_at FROM device_reader_sessions WHERE token_hash=?")
    .get(hashOf(first.cookie)) as { expires_at: number };
  expect(previous.expires_at).toBeLessThanOrEqual(Date.now() + 30000);
  h.db
    .prepare(
      "UPDATE device_reader_sessions SET expires_at=0 WHERE token_hash=?",
    )
    .run(hashOf(first.cookie));
  expect(await access(first.cookie)).toBe(401);
  expect(await access(next.cookie)).toBe(200);
  h.db
    .prepare("UPDATE devices SET reading=0 WHERE id=?")
    .run(a.device.deviceId);
  expect(await access(next.cookie)).toBe(401);
  expect(
    (await h.app.inject({ ...exchange, headers: a.headers })).statusCode,
  ).toBe(403);
  expect(await access(other.cookie)).toBe(200);
  expect(
    (
      await h.app.inject({
        method: "DELETE",
        url: "/api/devices/self",
        headers: b.headers,
      })
    ).statusCode,
  ).toBe(204);
  expect(await access(other.cookie)).toBe(401);
  expect(h.db.prepare("SELECT * FROM device_reader_sessions").all()).toEqual(
    [],
  );
});

it.each(["range", "slices"])(
  "withholds %s bytes if the device is revoked while its Drive read is pending",
  async (mode) => {
    const h = await fixture();
    const phone = await h.pair(true);
    phone.ack();
    const reader = await h.open(phone.headers);
    const bytes = Buffer.from("synthetic book content");
    const root: DriveFile = {
      id: "root",
      name: "Shelf",
      mimeType: "application/vnd.google-apps.folder",
    };
    const book: DriveFile = {
      id: "book",
      name: "Book.pdf",
      mimeType: "application/pdf",
      parents: [root.id],
      version: "1",
      size: String(bytes.length),
    };
    const readyBook = { ...book, id: "ready", name: "Ready.pdf" };
    const files = [root, readyBook, book];
    const sync = new LibrarySync(h.db, {
      get: async (id) => files.find((file) => file.id === id)!,
      list: async () => ({ files: [readyBook, book] }),
      startToken: async () => "fixture",
      changes: async () => ({ changed: false, newStartPageToken: "fixture" }),
    });
    await sync.syncLibrary(root.id, new AbortController().signal);
    const ref = await sync.verifyReading(book.id);
    const cache = new BlockCache(
      h.db,
      join(dirname(h.db.name), "in-flight-reader"),
      {
        maxBytes: 1000000n,
        minFreeBytes: 0n,
      },
      async (source) => {
        if (source.fileId === book.id)
          h.db
            .prepare("UPDATE devices SET revoked_at=? WHERE id=?")
            .run(Date.now(), phone.device.deviceId);
        return bytes;
      },
    );
    await cache.init();
    const app = Fastify();
    await app.register(cookiePlugin);
    registerReading(app, h.db, sync, cache, false);
    try {
      const read = (id: string, version: string) =>
        app.inject({
          url:
            `/api/reading/${id}/content?generation=${version}` +
            (mode === "slices" ? "&slices=0" : ""),
          headers: {
            ...reader,
            ...(mode === "range" ? { range: "bytes=0-3" } : {}),
          },
        });
      const ready = await sync.verifyReading(readyBook.id);
      const available = await read(ready.fileId, ready.generation);
      expect(available.statusCode).toBe(mode === "range" ? 206 : 200);
      expect(available.rawPayload).toEqual(
        mode === "range" ? bytes.subarray(0, 4) : bytes,
      );
      const response = await read(ref.fileId, ref.generation);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"]).toMatch(/json/);
      expect(response.body).not.toContain("synthetic");
      expect(
        h.db.prepare("SELECT count(*) AS n FROM device_reader_sessions").get(),
      ).toEqual({ n: 0 });
    } finally {
      await app.close();
    }
  },
);
