import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import type { DriveClient } from "../../apps/api/src/drive/client.js";
import { openDatabase, type Database } from "../../packages/db/src/open.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
import { VERIFY_REUSE_MS } from "../../apps/api/src/drive/sync.js";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import { parseMaster, parsePlaylist } from "../../apps/worker/src/hls.js";

// The whole path a film takes, with nothing replaced but Google: the real API
// listening on loopback, the real worker and FFmpeg, and a player's requests
// over HTTP. The unit suites each prove one side of a seam; this proves that
// what the worker writes is what the API will serve.

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const idle = () => new AbortController().signal;
const origin = "http://localhost:4310";

/** A short film in two languages with captions, as a Matroska file. */
async function film(dir: string) {
  const path = join(dir, "film.mkv");
  const subtitles = join(dir, "text.srt");
  const handle = await open(subtitles, "w");
  await handle.writeFile("1\n00:00:00,100 --> 00:00:01,500\nسلام cinema\n");
  await handle.close();
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24:duration=20",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=20",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=20",
      "-i",
      subtitles,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:a",
      "-map",
      "3:s",
      "-c:v",
      "libx264",
      "-threads:v",
      "1",
      "-preset",
      "ultrafast",
      "-g",
      "48",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-c:s",
      "srt",
      "-metadata:s:a:0",
      "language=eng",
      "-metadata:s:a:1",
      "language=fas",
      "-metadata:s:s:0",
      "language=fas",
      "-t",
      "20",
      path,
    ],
    idle(),
    30000,
  );
  return { path, size: (await stat(path)).size };
}

it("prepares a film in two languages and plays every part of it over HTTP", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-e2e-")));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const source = await film(dir);
  const files = [
    {
      id: "root",
      name: "Films",
      mimeType: "application/vnd.google-apps.folder",
      parents: [],
    },
    {
      id: "film",
      name: "Two Languages.mkv",
      mimeType: "video/x-matroska",
      parents: ["root"],
      version: "1",
      size: String(source.size),
    },
  ];
  const drive: DriveClient = {
    get: async (id) => files.find((f) => f.id === id)!,
    list: async () => ({ files: [files[1]!] }),
    startToken: async () => "one",
    changes: async () => ({ changed: false, newStartPageToken: "one" }),
  };
  const dataDir = join(dir, "data");
  const preparedDir = join(dir, "prepared");
  const workerKey = "cd".repeat(32);
  const app = await buildApp(
    parseConfig({
      mode: "test",
      dataDir,
      preparedDir,
      preparedFormat: "hls",
      minFreeBytes: 0,
      origin,
      clientId: "client",
      clientSecret: "secret",
      ownerSubject: "owner",
      encryptionKey: "ab".repeat(32),
      workerKey,
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
      // Google Drive, serving the film by byte range.
      sourceFetch: async (_url, init) => {
        const range = new Headers(init?.headers).get("range")!;
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
        const length = Number(b) - Number(a) + 1;
        const handle = await open(source.path, "r");
        try {
          const bytes = Buffer.alloc(length);
          await handle.read(bytes, 0, length, Number(a));
          return new Response(bytes, {
            status: 206,
            headers: {
              "content-range": `bytes ${a}-${b}/${source.size}`,
            },
          });
        } finally {
          await handle.close();
        }
      },
    },
  );
  clean.push(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const db = app.getDecorator<Database>("database");

  // Connect Drive as the owner, then hold an owner's session.
  const start = await app.inject("/auth/google/start");
  const state = new URL(start.headers.location!).searchParams.get("state");
  const callback = await app.inject({
    url: `/auth/google/callback?code=code&state=${state}`,
    headers: {
      cookie: start.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    },
  });
  expect(callback.statusCode).toBe(302);
  const session = issueSession(db, "owner");
  const headers = {
    cookie: `mov_session=${session.token}`,
    origin,
    "x-csrf-token": session.csrf,
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/library",
        headers,
        payload: { folderId: "root" },
      })
    ).statusCode,
  ).toBe(202);
  await expect
    .poll(
      async () => (await app.inject({ url: "/api/library", headers })).json(),
      { timeout: 5000 },
    )
    .toMatchObject({ state: "succeeded" });
  const [movie] = (await app.inject({ url: "/api/movies", headers })).json()
    .items as Array<{ id: string }>;

  // The worker is its own process in production, with its own connection.
  const workerDb = openDatabase(join(dataDir, "mov.sqlite"));
  clean.push(async () => workerDb.close());
  const worker = new MediaWorker(workerDb, address, workerKey, {
    directory: preparedDir,
    dataDir,
    production: false,
    format: "hls",
  });
  // A browser that plays H.264 and AAC in MP4, but not Matroska files.
  const play = () =>
    app.inject({
      method: "POST",
      url: "/api/playback",
      headers,
      payload: {
        movieId: movie!.id,
        profileId: "web",
        capabilities: { video: ["h264"], audio: ["aac"], containers: ["mp4"] },
      },
    });
  const pair = async (name: string) => {
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/pairing",
        payload: { name },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/pairing/approve",
          headers,
          payload: { code: challenge.code },
        })
      ).statusCode,
    ).toBe(204);
    const approval = (
      await app.inject({
        method: "POST",
        url: "/api/pairing/poll",
        payload: { id: challenge.id, pollSecret: challenge.pollSecret },
      })
    ).json();
    const bearer = { authorization: "Bearer " + approval.credential };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/pairing/ack",
          headers: bearer,
          payload: { id: challenge.id },
        })
      ).statusCode,
    ).toBe(204);
    return bearer;
  };
  const phone = await pair("Fixture phone");
  const tablet = await pair("Fixture tablet");
  const apple = (
    editionId?: string,
    generation?: string,
    device = phone,
    startMs = 0,
    replaceSessionId?: string,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/playback",
      headers: device,
      payload: {
        movieId: movie!.id,
        profileId: "apple-sdr-v1",
        startMs,
        replaceSessionId,
        editionId,
        generation,
        audioTrack: 1,
      },
    });
  const initial = await apple("source-film");
  expect(initial.statusCode).toBe(202);
  const statusUrl = "/api/preparations/" + initial.json().preparationId;
  const status = async () =>
    (await app.inject({ url: statusUrl, headers: phone })).json();
  expect(await status()).toEqual({ state: "queued" });
  expect((await apple("source-film")).json().preparationId).toBe(
    initial.json().preparationId,
  );
  const first = await play();
  expect([first.statusCode, first.json().phase]).toEqual([202, "inspecting"]);
  expect(await worker.runNextJob(idle(), "probe")).toBe("completed");
  const second = await play();
  expect([second.statusCode, second.json().phase]).toEqual([202, "queued"]);
  expect(await worker.runNextJob(idle(), "prepare")).toBe("completed");
  const ready = await play();
  expect(ready.statusCode).toBe(200);
  const playback = ready.json().session as {
    mediaUrl: string;
    label: string;
    subtitles: Array<{ url: string }>;
  };
  // The picture was copied, not re-encoded, and both languages came with it.
  expect(playback.label).toMatch(/Original picture/);
  expect(playback.mediaUrl).toMatch(/\/index\.m3u8$/);

  // What a player does: read the top-level playlist, then everything it names.
  const base = address + playback.mediaUrl.replace("index.m3u8", "");
  const get = async (name: string) => {
    const response = await fetch(base + name);
    expect(response.status, name).toBe(200);
    return response;
  };
  const top = parseMaster(await (await get("index.m3u8")).text());
  expect(top.renditions.map((r) => r.language)).toEqual(["eng", "fas"]);
  for (const [name, prefix] of [
    ["video.m3u8", "v-"],
    ["audio-0.m3u8", "a0-"],
    ["audio-1.m3u8", "a1-"],
  ] as const) {
    const playlist = parsePlaylist(await (await get(name)).text(), prefix);
    expect(playlist.ended, name).toBe(true);
    expect(Math.abs(playlist.seconds - 20), name).toBeLessThan(1);
    expect(
      (await (await get(`${prefix}init.mp4`)).arrayBuffer()).byteLength,
    ).toBeGreaterThan(0);
    for (const segment of playlist.segments)
      expect(
        (await (await get(segment.file)).arrayBuffer()).byteLength,
        segment.file,
      ).toBeGreaterThan(0);
  }
  expect(playback.subtitles).toHaveLength(1);
  const captions = await fetch(address + playback.subtitles[0]!.url);
  expect(captions.status).toBe(200);
  expect(await captions.text()).toContain("سلام cinema");

  // And a real demuxer, reading over HTTP, finds the picture and both languages.
  const seen = await probeMedia(
    address + playback.mediaUrl,
    idle(),
    undefined,
    "hls,mov",
  );
  expect(seen.video?.codec).toBe("h264");
  expect(seen.audio.map((a) => a.codec)).toEqual(["aac", "aac"]);
  expect(Math.abs(seen.durationMs - 20000)).toBeLessThan(1000);

  // Stopping ends it: the same addresses are refused.
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/playback/${ready.json().session.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(204);
  expect((await fetch(base + "video.m3u8")).status).toBe(403);

  // A completed probe must become the native rendition without another Play.
  await worker.queueLibrary();
  expect(await status()).toMatchObject({ state: "queued" });
  expect(await worker.runNextJob(idle(), "prepare")).toBe("completed");
  expect(await status()).toEqual({ state: "ready" });
  expect(await status()).toEqual({ state: "ready" });
  expect(db.prepare("SELECT count(*) n FROM playback_sessions").get()).toEqual({
    n: 1,
  });
  const stranger = issueSession(db, "owner");
  expect(
    (
      await app.inject({
        url: statusUrl,
        headers: { cookie: "mov_session=" + stranger.token },
      })
    ).statusCode,
  ).toBe(404);
  expect((await apple("missing")).statusCode).toBe(422);
  expect((await apple("source-film", "outdated")).statusCode).toBe(422);
  const remote = await apple("source-film");
  expect(remote.statusCode).toBe(200);
  const url = remote.json().session.mediaUrl as string;
  expect(url).toMatch(/video\.mp4$/);
  const range = await fetch(address + url, {
    headers: { Range: "bytes=100-199" },
  });
  expect(range.status).toBe(206);
  expect((await range.arrayBuffer()).byteLength).toBe(100);
  const nativeFilm = await probeMedia(address + url, idle());
  expect(nativeFilm.audio.map((t) => t.language)).toEqual(["fas"]);
  expect(nativeFilm.subtitles).toMatchObject([
    { codec: "mov_text", language: "fas" },
  ]);
  const lease = remote.json().session;
  const progress = {
    sessionId: lease.id,
    epoch: lease.epoch,
    sequence: 1,
    positionMs: 9500,
    ended: false,
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/progress",
        headers: phone,
        payload: progress,
      })
    ).json(),
  ).toEqual({ status: "accepted" });
  const renewed = await app.inject({
    method: "POST",
    url: "/api/playback/" + lease.id + "/heartbeat",
    headers: phone,
  });
  expect(renewed.json()).toMatchObject({
    id: lease.id,
    epoch: lease.epoch,
    startMs: 0,
  });
  const resume = (
    await app.inject({ url: "/api/continue-watching", headers: tablet })
  ).json().items[0];
  expect(resume).toMatchObject({ id: movie!.id, resumeMs: 9500 });
  const conflict = await apple(
    "source-film",
    undefined,
    tablet,
    resume.resumeMs,
  );
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().sessionId).toBe(lease.id);
  const takeover = await apple(
    "source-film",
    undefined,
    tablet,
    resume.resumeMs,
    conflict.json().sessionId,
  );
  expect(takeover.statusCode).toBe(200);
  expect(takeover.json().session.startMs).toBe(9500);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/progress",
        headers: phone,
        payload: { ...progress, sequence: 2, positionMs: 0 },
      })
    ).json(),
  ).toEqual({ status: "stale" });
  expect((await fetch(address + url)).status).toBe(403);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/devices/self",
        headers: tablet,
      })
    ).statusCode,
  ).toBe(204);
  expect((await fetch(address + takeover.json().session.mediaUrl)).status).toBe(
    403,
  );
  db.prepare(
    "UPDATE prepared_assets SET state='evicted' WHERE format='mp4'",
  ).run();
  expect(await status()).toEqual({ state: "evicted" });
  db.prepare(
    "UPDATE source_files SET generation='new-content' WHERE id='film'",
  ).run();
  expect(await status()).toEqual({
    state: "invalidated",
    reasonCode: "source_changed",
  });
}, 60000);

it("resumes interrupted book preparation and serves an authenticated range from the worker's cache", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ravan-reading-e2e-"));
  clean.push(() => rm(dataDir, { recursive: true, force: true }));
  const size = 9 * 1024 * 1024,
    bytes = Buffer.alloc(size, 91);
  const folder = {
    id: "root",
    name: "Books",
    mimeType: "application/vnd.google-apps.folder",
  };
  const book = {
    id: "volume",
    name: "Volume.pdf",
    mimeType: "application/pdf",
    size: String(size),
    parents: ["root"],
    version: "1",
    capabilities: { canDownload: true },
  };
  const key = "ce".repeat(32);
  const drive: DriveClient = {
    get: async (id) => (id === "root" ? folder : book),
    list: async () => ({ files: [book] }),
    startToken: async () => "one",
    changes: async () => ({ changed: false, newStartPageToken: "one" }),
  };
  const starts: number[] = [];
  let holdMiddle = true;
  let middleStarted = () => {};
  const entered = new Promise<void>((resolve) => {
    middleStarted = resolve;
  });
  let unblock = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
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
        const start = Number(a);
        starts.push(start);
        if (start === 4 * 1024 * 1024 && holdMiddle) {
          middleStarted();
          await gate;
        }
        return new Response(bytes.subarray(start, Number(b) + 1), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${b}/${size}` },
        });
      },
    },
  );
  clean.push(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const db = app.getDecorator<Database>("database");
  const login = await app.inject("/auth/google/start");
  const state = new URL(login.headers.location!).searchParams.get("state");
  const callback = await app.inject({
    url: `/auth/google/callback?code=ok&state=${state}`,
    headers: {
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    },
  });
  expect(callback.statusCode).toBe(302);
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
  const query = `?generation=${item.generation}`;
  const prep = "/api/reading/volume/preparation" + query;
  const url = "/api/reading/volume/content" + query;
  const workerRoute = `/_worker/reading/volume/${item.generation}/0`;
  expect(
    (await app.inject({ method: "POST", url: workerRoute })).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: prep,
        headers: { cookie: headers.cookie },
      })
    ).statusCode,
  ).toBe(403);
  let workerDb = openDatabase(join(dataDir, "mov.sqlite"));
  clean.push(async () => workerDb.close());
  const worker = new MediaWorker(workerDb, address, key);
  await worker.queueLibrary();
  expect((await app.inject({ url: prep, headers })).json()).toEqual({
    state: "queued",
    percent: 0,
  });
  await Promise.all(
    [1, 2].map(() => app.inject({ method: "POST", url: prep, headers })),
  );
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='reading'").get(),
  ).toEqual({ n: 1 });
  const stop = new AbortController();
  const running = worker.runNextJob(stop.signal, "reading");
  try {
    await entered;
    // Blocks are warmed together: the first and last become durable while
    // the middle one is still fetching.
    await expect
      .poll(async () => (await app.inject({ url: prep, headers })).json())
      .toEqual({ state: "preparing", percent: 55 });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/reading/volume/progress",
          headers,
          payload: { generation: item.generation, section: 12, fraction: 0.4 },
        })
      ).statusCode,
    ).toBe(204);
    const before = await app.inject({
      url,
      headers: { ...headers, range: "bytes=-17" },
    });
    expect(before.statusCode).toBe(206);
    expect(before.rawPayload.equals(bytes.subarray(-17))).toBe(true);
    stop.abort();
    expect(await running).toBe("retry");
    expect((await app.inject({ url: prep, headers })).json()).toEqual({
      state: "queued",
      percent: 55,
    });
  } finally {
    stop.abort();
    holdMiddle = false;
    unblock();
    // Wait for the lease to be released before afterEach closes SQLite on an assertion failure.
    await running;
  }
  workerDb.close();
  workerDb = openDatabase(join(dataDir, "mov.sqlite"));
  const restarted = new MediaWorker(workerDb, address, key);
  expect(await restarted.runNextJob(idle(), "reading")).toBe("completed");
  expect(starts.filter((i) => i === 0)).toHaveLength(1);
  expect(starts.filter((i) => i === 8 * 1024 * 1024)).toHaveLength(1);
  const ready = (await app.inject({ url: "/api/reading", headers })).json()
    .items[0];
  expect(ready.preparation).toEqual({ state: "ready", percent: 100 });
  expect(ready.position).toEqual({ section: 12, fraction: 0.4 });
  const count = starts.length;
  expect(
    (await app.inject({ url, headers: { ...headers, range: "bytes=40-50" } }))
      .rawPayload,
  ).toEqual(bytes.subarray(40, 51));
  expect(starts.length).toBe(count);
  book.capabilities.canDownload = false;
  // The last Drive answer may be reused for VERIFY_REUSE_MS, never longer.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + VERIFY_REUSE_MS });
  try {
    expect(
      (await app.inject({ url, headers: { ...headers, range: "bytes=40-50" } }))
        .statusCode,
    ).toBe(410);
  } finally {
    vi.useRealTimers();
  }
}, 30000);
