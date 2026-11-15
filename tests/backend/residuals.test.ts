import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { openDatabase, type Database } from "../../packages/db/src/open.js";
import {
  DriveError,
  type DriveClient,
  type DriveFile,
} from "../../apps/api/src/drive/client.js";
import { LibrarySync } from "../../apps/api/src/drive/sync.js";
import { TokenStore } from "../../apps/api/src/auth/token-store.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import { PairingService } from "../../apps/api/src/sessions/pairing.js";
import { probeRecord } from "../../apps/worker/src/probe.js";
import { createHarness } from "../fixtures/harness.js";

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const folder = "application/vnd.google-apps.folder";
const content = "0123456789";
function drive() {
  const files: DriveFile[] = [
    { id: "root", name: "Films", mimeType: folder, parents: [] },
    {
      id: "film",
      name: "Film.mp4",
      mimeType: "video/mp4",
      parents: ["root"],
      size: "10",
      version: "1",
    },
    {
      id: "other",
      name: "Other.mp4",
      mimeType: "video/mp4",
      parents: ["root"],
      size: "10",
      version: "1",
    },
    { id: "document", name: "Notes", mimeType: "text/plain", parents: [] },
  ];
  let failing = false;
  const calls = { list: 0, changes: 0 };
  let items: Array<{ fileId: string; parents?: string[] }> = [];
  const client: DriveClient = {
    get: async (id) => {
      if (failing) throw new DriveError(503);
      const file = files.find((f) => f.id === id);
      if (!file) throw new DriveError(404);
      return { ...file };
    },
    list: async (parent) => {
      calls.list++;
      return { files: files.filter((f) => f.parents?.includes(parent)) };
    },
    startToken: async () => "start",
    changes: async () => {
      calls.changes++;
      const page = { changed: items.length > 0, items, newStartPageToken: "n" };
      items = [];
      return page;
    },
  };
  return {
    files,
    client,
    calls,
    fail: (value: boolean) => {
      failing = value;
    },
    change: (...next: typeof items) => {
      items = next;
    },
  };
}
async function api(d = drive()) {
  const dataDir = await mkdtemp(join(tmpdir(), "mov-residual-"));
  const key = "ab".repeat(32);
  const app = await buildApp(
    parseConfig({
      mode: "test",
      dataDir,
      minFreeBytes: 0,
      origin: "http://localhost:4310",
      clientId: "client",
      clientSecret: "secret",
      ownerSubject: "owner",
      encryptionKey: key,
      workerKey: "c".repeat(64),
    }),
    {
      driveClient: d.client,
      oauthProvider: {
        authorizationUrl: () => "https://accounts.google.com/auth",
        exchange: async () => {
          throw new Error("unused");
        },
        refresh: async () => ({
          accessToken: "drive-token",
          expiresAt: Date.now() + 3600000,
        }),
      },
      sourceFetch: async (_url, init) => {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(
          new Headers(init?.headers).get("range")!,
        )!;
        return new Response(content.slice(Number(a), Number(b) + 1), {
          status: 206,
          headers: { "content-range": `bytes ${a}-${b}/10` },
        });
      },
    },
  );
  clean.push(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const db = app.getDecorator<Database>("database");
  new TokenStore(db, Buffer.from(key, "hex"), async () => ({
    accessToken: "drive-token",
    expiresAt: Date.now() + 3600000,
  })).saveRefreshToken("refresh");
  await new LibrarySync(db, d.client).syncLibrary(
    "root",
    new AbortController().signal,
  );
  const s = issueSession(db, "owner");
  return {
    app,
    db,
    drive: d,
    owner: {
      cookie: `mov_session=${s.token}`,
      origin: "http://localhost:4310",
      "x-csrf-token": s.csrf,
    },
  };
}
const workerKey = { authorization: `Bearer ${"c".repeat(64)}` };

it("gives FFmpeg a grant for one file instead of the worker key", async () => {
  const { app } = await api();
  // Issuing a grant needs the worker key.
  expect(
    (await app.inject({ method: "POST", url: "/_worker/grant/film" }))
      .statusCode,
  ).toBe(401);
  const granted = await app.inject({
    method: "POST",
    url: "/_worker/grant/film",
    headers: workerKey,
  });
  expect(granted.statusCode).toBe(200);
  const grant = { authorization: `Bearer ${granted.json().token}` };
  const read = await app.inject({
    url: "/_worker/source/film",
    headers: grant,
  });
  expect(read.statusCode).toBe(200);
  expect(read.body).toBe(content);
  // The grant opens only its own file, and the key itself opens no source.
  for (const [url, headers] of [
    ["/_worker/source/other", grant],
    ["/_worker/source/film", workerKey],
    ["/_worker/source/film", {}],
    ["/_worker/source/film", { authorization: `Bearer ${"x".repeat(43)}` }],
  ] as const)
    expect((await app.inject({ url, headers })).statusCode).toBe(401);
  // It cannot issue further grants or stand in for the worker key.
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/_worker/grant/other",
        headers: grant,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: "/_worker/verify/film", headers: grant }))
      .statusCode,
  ).toBe(401);
  // Revoked when the job ends.
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/_worker/grant",
        headers: workerKey,
        payload: { token: granted.json().token },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await app.inject({ url: "/_worker/source/film", headers: grant }))
      .statusCode,
  ).toBe(401);
});

it("does not grant a file outside the library", async () => {
  const { app } = await api();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/_worker/grant/document",
        headers: workerKey,
      })
    ).statusCode,
  ).toBeGreaterThanOrEqual(400);
});

it("checks a new library folder before it replaces a working one", async () => {
  const { app, db, owner, drive: d } = await api();
  const choose = (folderId: string) =>
    app.inject({
      method: "POST",
      url: "/api/library",
      headers: owner,
      payload: { folderId },
    });
  const folderId = () =>
    (
      db.prepare("SELECT folder_id FROM sync_checkpoints").get() as {
        folder_id: string;
      }
    ).folder_id;
  // A mistyped id, and an id that is a file rather than a folder.
  for (const bad of ["no-such-folder", "document"]) {
    const response = await choose(bad);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_folder" });
  }
  expect(folderId()).toBe("root");
  expect(
    db.prepare("SELECT COUNT(*) n FROM source_files WHERE available=1").get(),
  ).toEqual({ n: 2 });
  // Drive being unreachable is not the folder's fault, and changes nothing either.
  d.fail(true);
  expect((await choose("elsewhere")).statusCode).toBe(503);
  expect(folderId()).toBe("root");
  d.fail(false);
  // Re-selecting the current folder, or a real new one, is accepted.
  expect((await choose("root")).statusCode).toBe(202);
  d.files.push({ id: "second", name: "More", mimeType: folder, parents: [] });
  expect((await choose("second")).statusCode).toBe(202);
});

it("ignores Drive changes that cannot affect the library", async () => {
  const d = drive();
  const dir = await mkdtemp(join(tmpdir(), "mov-feed-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const sync = new LibrarySync(db, d.client);
  const idle = new AbortController().signal;
  await sync.syncLibrary("root", idle);
  const refresh = async () => {
    d.calls.list = 0;
    await sync.syncLibrary("root", idle, { incremental: true });
    return d.calls.list;
  };
  // An edit to an unrelated document, and the removal of a file never catalogued.
  d.change({ fileId: "document", parents: ["somewhere-else"] });
  expect(await refresh()).toBe(0);
  d.change({ fileId: "never-seen" });
  expect(await refresh()).toBe(0);
  // A catalogued file changed or removed.
  d.change({ fileId: "film" });
  expect(await refresh()).toBe(1);
  // Something new placed in a library folder.
  d.change({ fileId: "brand-new", parents: ["root"] });
  expect(await refresh()).toBe(1);
  // The library folder itself.
  d.change({ fileId: "root" });
  expect(await refresh()).toBe(1);
  // A change Drive could not identify is treated as relevant.
  d.change({ fileId: "" });
  expect(await refresh()).toBe(1);
});

it("keeps room for a real TV when anonymous pairing requests pile up", async () => {
  const h = await createHarness();
  clean.push(h.close);
  let now = 10000;
  const pairing = new PairingService(h.db, Buffer.alloc(32, 3), () => now);
  const first = pairing.create("first");
  const approved = pairing.create("approved");
  pairing.approve(approved.code);
  for (let i = 0; i < 98; i++) {
    now += 1;
    pairing.create(`filler ${i}`);
  }
  // At capacity: the newest request is admitted and the oldest unapproved one goes.
  const tv = pairing.create("Living room");
  expect(tv.code).toHaveLength(8);
  expect(() => pairing.poll(first.id, first.pollSecret)).toThrow();
  expect(pairing.poll(tv.id, tv.pollSecret).state).toBe("pending");
  expect(
    h.db
      .prepare("SELECT state FROM pairing_requests WHERE id=?")
      .get(approved.id),
  ).toEqual({ state: "approved" });
  expect(h.db.prepare("SELECT COUNT(*) n FROM pairing_requests").get()).toEqual(
    { n: 100 },
  );
});

it("removes dead sessions at startup and keeps live ones and the newest epoch", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mov-prune-"));
  clean.push(() => rm(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ mode: "test", dataDir, minFreeBytes: 0 });
  const db = openDatabase(join(dataDir, "mov.sqlite"));
  const now = Date.now(),
    day = 86400000;
  db.exec(
    "INSERT INTO movies(id,title) VALUES('m','Film'); INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('f','m','g','10')",
  );
  const session = db.prepare("INSERT INTO web_sessions VALUES(?,?,?,?)");
  session.run("expired", "owner", "csrf", now - 1000);
  session.run("live", "owner", "csrf", now + day);
  const playback = db.prepare(
    "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,epoch,lease_until,access_until,expires_at,revoked_at) VALUES(?,?,'m','f','g',?,?,?,?,?)",
  );
  playback.run("ancient", "t1", 1, 0, 0, now - 40 * day, now - 40 * day);
  playback.run("recent", "t2", 2, 0, 0, now - 2 * day, now - 2 * day);
  playback.run("newest-but-old", "t3", 3, 0, 0, now - 35 * day, now - 35 * day);
  db.close();
  const app = await buildApp(config);
  clean.push(() => app.close());
  const after = app.getDecorator<Database>("database");
  expect(after.prepare("SELECT token_hash FROM web_sessions").all()).toEqual([
    { token_hash: "live" },
  ]);
  // The oldest row goes; the newest epoch stays even though it is old.
  expect(
    after.prepare("SELECT id FROM playback_sessions ORDER BY epoch").all(),
  ).toEqual([{ id: "recent" }, { id: "newest-but-old" }]);
});

it("rejects a stored probe the worker could not safely build a command from", () => {
  const good = {
    generation: "g",
    version: 2,
    probe: {
      durationMs: 1000,
      container: "matroska,webm",
      video: {
        codec: "h264",
        pixelFormat: "yuv420p",
        width: 1920,
        height: 1080,
        hdr: false,
      },
      audio: [{ codec: "aac", channels: 2, index: 1 }],
      subtitles: [{ codec: "subrip", index: 2 }],
    },
  };
  expect(probeRecord.safeParse(good).success).toBe(true);
  for (const bad of [
    { ...good, probe: { ...good.probe, durationMs: "long" } },
    {
      ...good,
      probe: {
        ...good.probe,
        video: { ...good.probe.video, width: "1920:flags=x" },
      },
    },
    {
      ...good,
      probe: {
        ...good.probe,
        subtitles: [{ codec: "subrip", index: "0 -i /etc/passwd" }],
      },
    },
    {
      ...good,
      probe: { ...good.probe, audio: Array(101).fill(good.probe.audio[0]) },
    },
    { generation: "g" },
  ])
    expect(probeRecord.safeParse(bad).success).toBe(false);
});

it("tells the worker whether a film is gone or Drive should be asked again", async () => {
  const { app, drive: d } = await api();
  const verify = (id: string) =>
    app.inject({ url: `/_worker/verify/${id}`, headers: workerKey });
  expect((await verify("film")).statusCode).toBe(200);
  // Not in the catalogue, and catalogued but deleted in Drive: a verdict on the job.
  expect((await verify("document")).statusCode).toBe(410);
  d.files.splice(
    d.files.findIndex((f) => f.id === "other"),
    1,
  );
  const gone = await verify("other");
  expect(gone.statusCode).toBe(410);
  expect(gone.json()).toEqual({ error: "source_unavailable" });
  // Drive itself failing says nothing about the film.
  d.fail(true);
  const later = await verify("film");
  expect(later.statusCode).toBe(503);
  expect(later.json()).toEqual({ error: "try_later" });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/_worker/grant/film",
        headers: workerKey,
      })
    ).statusCode,
  ).toBe(503);
});

it("does not rate-limit the worker's own loopback routes, and expires inspection grants sooner", async () => {
  const { app } = await api();
  // Back-to-back inspections make far more than 120 calls a minute.
  let last = 200;
  for (let i = 0; i < 130; i++)
    last = (
      await app.inject({ url: "/_worker/verify/film", headers: workerKey })
    ).statusCode;
  expect(last).toBe(200);
  // Public routes are still limited.
  for (let i = 0; i < 130; i++)
    last = (await app.inject("/healthz")).statusCode;
  expect(last).toBe(429);
  const { vi } = await import("vitest");
  const grant = async (life: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/_worker/grant/film?life=${life}`,
        headers: workerKey,
      })
    ).json().token as string;
  const short = await grant("short"),
    long = await grant("long");
  const read = async (token: string) =>
    (
      await app.inject({
        url: "/_worker/source/film",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode;
  expect([await read(short), await read(long)]).toEqual([200, 200]);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60000);
  try {
    expect([await read(short), await read(long)]).toEqual([401, 200]);
  } finally {
    clock.mockRestore();
  }
});

it("does not report a scan that a concurrent scan prevented from starting", async () => {
  const { app, db, owner, drive: d } = await api();
  d.files.push({ id: "second", name: "More", mimeType: folder, parents: [] });
  const get = d.client.get;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let scanning!: () => void;
  const scanHeld = new Promise<void>((resolve) => (scanning = resolve));
  // Drive is slow to confirm the new folder...
  d.client.get = async (id, signal) => {
    if (id === "second") await held;
    return get(id, signal);
  };
  const list = d.client.list;
  d.client.list = async (parent, page, signal) => {
    await scanHeld;
    return list(parent, page, signal);
  };
  const change = app.inject({
    method: "POST",
    url: "/api/library",
    headers: owner,
    payload: { folderId: "second" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // ...and meanwhile a scan of the current folder starts.
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/library/sync",
        headers: owner,
        payload: {},
      })
    ).statusCode,
  ).toBe(202);
  release();
  const response = await change;
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: "scan_in_progress" });
  scanning();
  expect(db.prepare("SELECT folder_id FROM sync_checkpoints").get()).toEqual({
    folder_id: "root",
  });
});
