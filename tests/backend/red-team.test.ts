import { afterEach, expect, it } from "vitest";
import http from "node:http";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import { crc32, createDeflate } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import {
  hash,
  issueSession,
  secret,
} from "../../apps/api/src/auth/sessions.js";
import type { Database } from "../../packages/db/src/open.js";
import { PROBE_VERSION, probeMedia } from "../../apps/worker/src/probe.js";
import { runProcess } from "../../apps/worker/src/process.js";
import { extractArtwork } from "../../apps/worker/src/artwork.js";
import {
  captionsTooDense,
  prepareBrowser,
} from "../../apps/worker/src/browser-prepare.js";

// Regression tests from the red-team exercise of 16 November 2026
// (the red-team report). Each is an attack that worked.

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const workerKey = "cd".repeat(32);
const generation = "a".repeat(64);
/** The real API with sign-in configured, three films, a paired screen and an owner. */
async function cinema() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-rt-")));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  let exchanges = 0;
  const app = await buildApp(
    parseConfig({
      mode: "test",
      dataDir: join(dir, "data"),
      preparedDir: join(dir, "prepared"),
      preparedFormat: "hls",
      minFreeBytes: 0,
      origin: "http://localhost:4310",
      clientId: "client",
      clientSecret: "secret",
      ownerSubject: "owner",
      encryptionKey: "ab".repeat(32),
      workerKey,
    }),
    {
      oauthProvider: {
        authorizationUrl: ({ state }) =>
          `https://accounts.google.com/auth?state=${state}`,
        exchange: async (_code, _verifier, nonce) => {
          exchanges++;
          return {
            subject: "owner",
            nonce,
            accessToken: "a",
            refreshToken: "r",
            expiresAt: Date.now() + 3600000,
          };
        },
        refresh: async () => ({
          accessToken: "a",
          expiresAt: Date.now() + 3600000,
        }),
      },
      driveClient: {
        get: async (id) =>
          id === "root"
            ? {
                id,
                name: "Films",
                mimeType: "application/vnd.google-apps.folder",
                parents: [],
              }
            : {
                id,
                name: "Film.mkv",
                mimeType: "video/x-matroska",
                parents: ["root"],
                size: "1000000",
                version: "1",
              },
        list: async () => ({ files: [] }),
        startToken: async () => "t",
        changes: async () => ({ changed: false, newStartPageToken: "t" }),
      },
    },
  );
  clean.push(() => app.close());
  const db = app.getDecorator<Database>("database");
  db.prepare(
    "INSERT INTO sync_checkpoints(id,folder_id,state,counts) VALUES('library','root','succeeded','{}')",
  ).run();
  // 4K HDR films in two languages: every picture size is a conversion.
  for (const n of [1, 2, 3]) {
    const file = `drivefile${n}`;
    db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(`m${n}`, "Film");
    db.prepare(
      "INSERT INTO source_files(id,movie_id,generation,size_bytes,name,mime_type,metadata) VALUES(?,?,?,?,?,?,?)",
    ).run(
      file,
      `m${n}`,
      generation,
      "1000000",
      "Film.mkv",
      "video/x-matroska",
      JSON.stringify({ id: file, size: "1000000", version: "1" }),
    );
    db.prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES(?,?,?,'Original',?)",
    ).run(`source-${file}`, `m${n}`, file, generation);
    db.prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES(?,?,'probe','metadata',?)",
    ).run(
      `probe-${file}`,
      `source-${file}`,
      JSON.stringify({
        version: PROBE_VERSION,
        generation,
        probe: {
          durationMs: 7200000,
          container: "matroska,webm",
          video: {
            codec: "hevc",
            pixelFormat: "yuv420p10le",
            width: 3840,
            height: 2160,
            hdr: true,
          },
          audio: [
            { codec: "eac3", channels: 6, language: "eng", default: true },
            { codec: "aac", channels: 2, language: "jpn" },
          ],
          subtitles: [],
        },
      }),
    );
  }
  const credential = secret();
  db.prepare(
    "INSERT INTO devices(id,name,token_hash) VALUES('tv','LG C1',?)",
  ).run(hash(credential));
  const session = issueSession(db, "owner");
  return {
    app,
    db,
    exchanges: () => exchanges,
    device: { authorization: `Bearer ${credential}` },
    owner: {
      cookie: `mov_session=${session.token}`,
      origin: "http://localhost:4310",
      "x-csrf-token": session.csrf,
    },
  };
}
const cookies = (response: {
  cookies: Array<{ name: string; value: string }>;
}) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const stateOf = (response: { headers: Record<string, unknown> }) =>
  new URL(String(response.headers.location)).searchParams.get("state")!;

it("lets no number of other visitors' sign-in attempts end the owner's", async () => {
  const h = await cinema();
  const start = await h.app.inject({
    url: "/auth/google/start",
    remoteAddress: "203.0.113.1",
  });
  // Ten networks, each inside its own limit: a hundred attempts in seconds.
  for (let network = 1; network <= 10; network++)
    for (let i = 0; i < 10; i++)
      expect(
        (
          await h.app.inject({
            url: "/auth/google/start",
            remoteAddress: `198.51.100.${network}`,
          })
        ).statusCode,
      ).toBe(302);
  const callback = await h.app.inject({
    url: `/auth/google/callback?code=code&state=${stateOf(start)}`,
    remoteAddress: "203.0.113.1",
    headers: { cookie: cookies(start) },
  });
  expect(callback.statusCode).toBe(302);
});

it("accepts a sign-in answer only with the cookie of the attempt it belongs to, once", async () => {
  const h = await cinema();
  const mine = await h.app.inject("/auth/google/start");
  const other = await h.app.inject("/auth/google/start");
  const answer = (state: string, cookie: string) =>
    h.app.inject({
      url: `/auth/google/callback?code=code&state=${state}`,
      headers: { cookie },
    });
  // Another attempt's cookie, an altered one, none at all, a made-up state.
  const cookie = cookies(mine);
  for (const [state, jar] of [
    [stateOf(mine), cookies(other)],
    [stateOf(other), cookie],
    [stateOf(mine), cookie.slice(0, -4) + "AAAA"],
    [stateOf(mine), ""],
    ["x".repeat(43), cookie],
  ] as const)
    expect((await answer(state, jar)).statusCode, `${state} ${jar}`).toBe(400);
  expect(h.exchanges()).toBe(0);
  expect((await answer(stateOf(mine), cookie)).statusCode).toBe(302);
  // The same answer a second time is refused before Google is asked again.
  expect((await answer(stateOf(mine), cookie)).statusCode).toBe(400);
  expect(h.exchanges()).toBe(1);
});

/** One request over a real socket, its path sent exactly as written. */
function raw(address: string, path: string, headers: Record<string, string>) {
  const { hostname, port } = new URL(address);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      { hostname, port, path, headers, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

it("answers only plainly written paths, whatever a proxy in front made of them", async () => {
  const h = await cinema();
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
  // The origin's proxy picks its rule from the path with ".." and "%2f"
  // resolved, then forwards the path as written. These reached the API past
  // the origin key, and the worker's routes from the internet.
  for (const url of [
    "/api/movies/..%2f..%2fmedia%2fx/pictures",
    "/api/artwork/..%2F..%2Fmedia%2Fx",
    "/api/session/..%2f..%2fmedia/x",
    "/_worker/verify/..%2f..%2fmedia%2fx",
    "/_worker/source/..%2f..%2fmedia%2fx",
    "/api/movies/%2e%2e/%2e%2e/media/x",
    "/api/movies/../../media/x",
    "/api/./session",
    "/api//session",
    "//api/session",
    "/api/session%5c..%5cmovies",
    "/api/movies/%252e%252e",
    "/media/s/x/..%2f..%2fapi%2fsession",
  ])
    for (const headers of [
      {},
      h.owner,
      h.device,
      { authorization: `Bearer ${workerKey}` },
    ]) {
      const response = await raw(address, url, headers);
      expect([response.status, response.body], url).toEqual([
        404,
        '{"error":"not_found"}',
      ]);
    }
  // Ordinary requests are untouched, query strings included.
  expect(
    (
      await h.app.inject({
        url: "/api/movies?q=50%25%20off%2F..",
        headers: h.owner,
      })
    ).statusCode,
  ).toBe(200);
  expect((await h.app.inject("/api/session")).statusCode).toBe(200);
});

it("limits how much conversion work a paired screen can have waiting", async () => {
  const h = await cinema();
  const ask = (headers: Record<string, string>, payload: object) =>
    h.app.inject({ method: "POST", url: "/api/playback", headers, payload });
  const waiting = () =>
    (
      h.db
        .prepare(
          "SELECT count(*) n FROM jobs WHERE kind='browser-prepare' AND state IN ('queued','running')",
        )
        .get() as { n: number }
    ).n;
  // A screen asks for every film in every size, forced and not.
  const answers: number[] = [];
  for (const movieId of ["m1", "m2", "m3"])
    for (const quality of ["auto", "480p", "720p", "1080p", "1440p"])
      for (const forceCompatible of [false, true])
        answers.push(
          (
            await ask(h.device, {
              movieId,
              profileId: "lg-c1",
              quality,
              forceCompatible,
            })
          ).statusCode,
        );
  expect(waiting()).toBe(3);
  // What it was refused, it was told plainly. A request for an edition
  // already waiting (the same one under another size's name) is joined.
  expect(answers.every((status) => status === 202 || status === 422)).toBe(
    true,
  );
  expect(
    answers.filter((status) => status === 422).length,
  ).toBeGreaterThanOrEqual(20);
  const again = await ask(h.device, { movieId: "m1", profileId: "lg-c1" });
  expect(again.statusCode).toBe(202);
  // The owner is not held to the screen's limit.
  const owner = await ask(h.owner, {
    movieId: "m3",
    profileId: "web",
    quality: "480p",
  });
  expect(owner.statusCode).toBe(202);
  expect(waiting()).toBe(4);
});

it("has the origin's proxy pass on only media addresses written plainly", async () => {
  // Nginx cannot be run here; this checks the rule's pattern, as written in
  // the template, against what it must and must not let through.
  const template = await readFile(
    new URL("../../deploy/nginx/ravan-origin.conf.template", import.meta.url),
    "utf8",
  );
  const media = template.slice(template.indexOf("location ^~ /media/"));
  const rule = /if \(\$request_uri !~ "([^"]+)"\) \{ return 404; \}/.exec(
    media,
  );
  expect(
    rule,
    "the raw-path rule is the first thing in the media location",
  ).not.toBeNull();
  expect(media.indexOf(rule![0])).toBeLessThan(media.indexOf("proxy_pass"));
  const allowed = new RegExp(rule![1]!);
  const ticket = "A".repeat(43);
  for (const path of [
    `/media/s/${ticket}/raw`,
    `/media/s/${ticket}/index.m3u8`,
    `/media/s/${ticket}/v-seg-00012.m4s`,
    `/media/s/${ticket}/a1-init.mp4`,
    `/media/s/${ticket}/subtitle-3.vtt`,
    `/media/s/${ticket}/video.mp4?x=1`,
  ])
    expect(allowed.test(path), path).toBe(true);
  for (const path of [
    "/api/movies/..%2f..%2fmedia%2fx/pictures",
    "/_worker/verify/..%2f..%2fmedia%2fx",
    "/api/session/..%2f..%2fmedia/x",
    `/media/s/${ticket}/..%2f..%2fapi%2fsession`,
    `/media/s/${ticket}/..`,
    `/media/s/${ticket}/a/b`,
    `/media/s/${ticket}/`,
    "/media/../api/session",
    "//media/s/x/raw",
    "/media/x",
  ])
    expect(allowed.test(path), path).toBe(false);
});

/** A PNG of one flat colour: a few hundred kilobytes on disk, vast decoded. */
async function flatPng(path: string, side: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const frame = Buffer.alloc(8 + body.length);
    frame.writeUInt32BE(data.length, 0);
    body.copy(frame, 4);
    frame.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
    return frame;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (part: Buffer) => parts.push(part));
  const row = Buffer.alloc(1 + side * 3);
  for (let y = 0; y < side; y++)
    if (!deflate.write(row)) await once(deflate, "drain");
  deflate.end();
  await once(deflate, "end");
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", Buffer.concat(parts)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

it("does not decode a cover of a hundred million pixels to make a poster", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-rt-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const idle = new AbortController().signal;
  // Under a megabyte in the film; about half a gigabyte of memory to decode,
  // inside a worker that shares two with a running conversion.
  const cover = join(dir, "cover.png");
  await flatPng(cover, 12000);
  expect((await stat(cover)).size).toBeLessThan(1024 * 1024);
  const film = join(dir, "film.mkv");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-attach",
      cover,
      "-metadata:s:t",
      "mimetype=image/png",
      "-metadata:s:t",
      "filename=cover.png",
      film,
    ],
    idle,
    60000,
  );
  const pictures = await extractArtwork(
    film,
    undefined,
    await probeMedia(film, idle),
    join(dir, "artwork"),
    idle,
  );
  // The film still gets its pictures, from its own frames.
  expect(pictures.map((p) => `${p.kind}:${p.provider}`).sort()).toEqual([
    "poster:frame",
    "still:frame",
  ]);
}, 120000);

it("starts FFmpeg without the service's secrets in its environment", async () => {
  // The worker's environment holds the encryption key, the worker key and the
  // Google client secret. A media tool that a crafted film takes over could
  // read its own environment; it has no use for any of them.
  const names = [
    "MOV_ENCRYPTION_KEY",
    "MOV_WORKER_KEY",
    "GOOGLE_CLIENT_SECRET",
    "MOV_TMDB_TOKEN",
    "MOV_BACKUP_KEY",
  ];
  const before = names.map((name) => process.env[name]);
  clean.push(async () => {
    names.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
  });
  for (const name of names) process.env[name] = `secret-value-of-${name}`;
  const seen = await runProcess("env", [], new AbortController().signal);
  for (const name of names) expect(seen, name).not.toContain(name);
  expect(seen).not.toContain("secret-value-of");
  // It can still be found and run.
  expect(seen).toMatch(/^PATH=/m);
});

it("lets a screen give up its own credential when it is disconnected", async () => {
  const h = await cinema();
  // "Disconnect this TV" used to forget the credential on the screen only: it
  // stayed valid on the server, and each new pairing added another screen
  // with the same name to the owner's list.
  expect(
    (
      await h.app.inject({
        method: "POST",
        url: "/api/pairing/forget",
        headers: h.owner,
        payload: {},
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await h.app.inject({ url: "/api/devices", headers: h.owner })).json(),
  ).toHaveLength(1);
  const forgotten = await h.app.inject({
    method: "POST",
    url: "/api/pairing/forget",
    headers: h.device,
    payload: {},
  });
  expect(forgotten.statusCode).toBe(204);
  expect(
    (await h.app.inject({ url: "/api/movies", headers: h.device })).statusCode,
  ).toBe(401);
  expect(
    (await h.app.inject({ url: "/api/devices", headers: h.owner })).json(),
  ).toEqual([]);
  // Without a credential there is nothing to give up, and nothing is told.
  expect(
    (await h.app.inject({ method: "POST", url: "/api/pairing/forget" }))
      .statusCode,
  ).toBe(401);
});

it("leaves out a caption track built to stall the player, and keeps the others", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-rt-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const idle = new AbortController().signal;
  // Four thousand cues on screen at once: a few hundred kilobytes that held a
  // browser's main thread for seconds to minutes.
  const pile = Array.from(
    { length: 4000 },
    (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:09,000\nline ${i}\n`,
  ).join("\n");
  await writeFile(join(dir, "pile.srt"), pile);
  await writeFile(
    join(dir, "plain.srt"),
    "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nGoodbye\n",
  );
  const film = join(dir, "film.mkv");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24:duration=10",
      "-i",
      join(dir, "pile.srt"),
      "-i",
      join(dir, "plain.srt"),
      "-map",
      "0:v",
      "-map",
      "1:s",
      "-map",
      "2:s",
      "-c:v",
      "libx264",
      "-g",
      "48",
      "-pix_fmt",
      "yuv420p",
      "-c:s",
      "srt",
      film,
    ],
    idle,
    60000,
  );
  const output = join(dir, "edition");
  const result = await prepareBrowser(
    film,
    output,
    await probeMedia(film, idle),
    "auto",
    0,
    idle,
    { maxBytes: 64 * 1024 ** 2, format: "hls", verify: async () => {} },
  );
  expect(result.captions.map((c) => c.file)).toEqual(["subtitle-1.vtt"]);
  await expect(stat(join(output, "subtitle-0.vtt"))).rejects.toThrow();
  expect(await readFile(join(output, "subtitle-1.vtt"), "utf8")).toContain(
    "Goodbye",
  );
  // Ordinary captions pass, however many, while few share the screen.
  const ordinary =
    "WEBVTT\n\n" +
    Array.from(
      { length: 6000 },
      (_, i) =>
        `00:${String(Math.floor(i / 30)).padStart(2, "0")}:${String((i % 30) * 2).padStart(2, "0")}.000 --> 00:${String(Math.floor(i / 30)).padStart(2, "0")}:${String((i % 30) * 2 + 1).padStart(2, "0")}.900\nline ${i}\n`,
    ).join("\n");
  expect(captionsTooDense(ordinary)).toBe(false);
}, 120000);
