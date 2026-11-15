import { afterEach, expect, it } from "vitest";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import type { DriveClient } from "../../apps/api/src/drive/client.js";
import { openDatabase, type Database } from "../../packages/db/src/open.js";
import { MediaWorker } from "../../apps/worker/src/main.js";
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
}, 60000);
