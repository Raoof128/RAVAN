import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../fixtures/harness.js";
import { sessionFixture } from "../fixtures/session-harness.js";
import { PlaybackService } from "../../apps/api/src/sessions/playback.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import { scanRunner } from "../../apps/api/src/library/import.js";
import { PairingService } from "../../apps/api/src/sessions/pairing.js";
import {
  createDriveClient,
  DriveError,
  DRIVE_RATE_LIMIT_ATTEMPTS,
} from "../../apps/api/src/drive/client.js";
import { sourceGone } from "../../apps/api/src/drive/sync.js";
import { DriveSourceReader } from "../../apps/api/src/media/source-stream.js";
import { MediaPlanner } from "../../apps/api/src/media/planner.js";
import {
  PROBE_VERSION,
  pictureMs,
  probeMedia,
} from "../../apps/worker/src/probe.js";
import { runProcess } from "../../apps/worker/src/process.js";
import { prepareBrowser } from "../../apps/worker/src/browser-prepare.js";
import { validateEdition, writeMaster } from "../../apps/worker/src/hls.js";
import { localReader } from "../../apps/worker/src/prepared-store.js";

// Regression tests for the backend audit of 16 November 2026
// (the second audit report). Each failed before its fix.

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of clean.splice(0).reverse()) await f();
});
const source = { fileId: "f", generation: "generation", sizeBytes: "10" };
const owner = { webHash: "owner" };

/** An all-languages edition on disk: a picture stream and two languages. */
async function allLanguagesEdition(dir: string, id: string) {
  await mkdir(join(dir, id));
  const media = (prefix: string) =>
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXT-X-MAP:URI="${prefix}init.mp4"`,
      "#EXTINF:6.000000,",
      `${prefix}seg-00000.m4s`,
      "#EXT-X-ENDLIST",
    ].join("\n") + "\n";
  await writeFile(
    join(dir, id, "index.m3u8"),
    writeMaster(
      [
        { name: "English", language: "eng", default: true },
        { name: "Persian", language: "fas", default: false },
      ],
      1_000_000,
    ),
  );
  for (const [name, prefix] of [
    ["video.m3u8", "v-"],
    ["audio-0.m3u8", "a0-"],
    ["audio-1.m3u8", "a1-"],
  ] as const) {
    await writeFile(join(dir, id, name), media(prefix));
    await writeFile(join(dir, id, `${prefix}init.mp4`), `INIT ${prefix}`);
    await writeFile(join(dir, id, `${prefix}seg-00000.m4s`), "0123456789");
  }
  return media;
}

it("serves every file of an all-languages edition to its session", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-audit-")));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const h = await sessionFixture({ preparedDir: dir, preparedFormat: "hls" });
  const id = "e".repeat(64);
  const media = await allLanguagesEdition(dir, id);
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,format,label) VALUES(?,'f','generation','auto',-1,'ready',0,'hls','Original picture')",
    )
    .run(id);
  const service = new PlaybackService(
    h.db,
    async () => source,
    async () => ({ mode: "prepared", assetId: id }),
  );
  const result = await service.create("m", "web", 0, owner);
  if (result.kind !== "ready") throw Error("not ready");
  const base = result.session.mediaUrl.replace("index.m3u8", "");
  // The top-level playlist names these; a player fetches each of them.
  for (const [name, prefix] of [
    ["video.m3u8", "v-"],
    ["audio-0.m3u8", "a0-"],
    ["audio-1.m3u8", "a1-"],
  ] as const) {
    const playlist = await h.app.inject(base + name);
    expect([playlist.statusCode, playlist.body], name).toEqual([
      200,
      media(prefix),
    ]);
    expect(playlist.headers["content-type"]).toContain(
      "application/vnd.apple.mpegurl",
    );
    const init = await h.app.inject(`${base}${prefix}init.mp4`);
    expect([init.statusCode, init.body], `${prefix}init`).toEqual([
      200,
      `INIT ${prefix}`,
    ]);
    const part = await h.app.inject({
      url: `${base}${prefix}seg-00000.m4s`,
      headers: { range: "bytes=2-5" },
    });
    expect([part.statusCode, part.body], `${prefix}seg`).toEqual([206, "2345"]);
  }
  // Still nothing but the names this server writes, and only files that exist.
  for (const path of [
    "audio-2.m3u8",
    "a2-init.mp4",
    "a0-seg-1.m4s",
    "v-seg-00000.m4s.tmp",
    "audio-100.m3u8",
    "video.mp4",
    "raw",
    `../${id}/v-init.mp4`,
  ])
    expect((await h.app.inject(base + path)).statusCode, path).toBe(403);
  // A stream's playlist is passed on only under its own name.
  await writeFile(join(dir, id, "audio-1.m3u8"), media("a0-"));
  expect((await h.app.inject(base + "audio-1.m3u8")).statusCode).toBe(403);
  // A single-file edition does not gain these names.
  h.db.prepare("UPDATE prepared_assets SET format='mp4' WHERE id=?").run(id);
  const ticket = result.session.mediaUrl.split("/")[3]!;
  for (const path of ["video.m3u8", "v-init.mp4", "a0-seg-00000.m4s"])
    await expect(service.authorizeMedia(ticket, path), path).rejects.toThrow();
});

it("reads the files of either layout from a prepared edition, and no others", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ravan-audit-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const id = "a".repeat(64);
  await mkdir(join(dir, id));
  const read = async (file: string) => {
    const parts: Buffer[] = [];
    for await (const part of localReader(dir, file).readSource(
      { fileId: id },
      0n,
      3n,
      new AbortController().signal,
    ))
      parts.push(Buffer.from(part));
    return Buffer.concat(parts).toString();
  };
  for (const file of [
    "video.mp4",
    "init.mp4",
    "seg-00003.m4s",
    "v-init.mp4",
    "v-seg-00003.m4s",
    "a0-init.mp4",
    "a15-seg-00003.m4s",
    "subtitle-2.vtt",
  ]) {
    await writeFile(join(dir, id, file), "DATA");
    expect(await read(file), file).toBe("DATA");
  }
  await writeFile(join(dir, id, "notes.txt"), "DATA");
  for (const file of ["notes.txt", "index.m3u8", "../" + id + "/video.mp4"])
    await expect(read(file), file).rejects.toThrow("Invalid prepared asset");
});

/** A service on its own clock, whose Drive check the test controls. */
async function renewing(verify: () => Promise<typeof source>) {
  const h = await sessionFixture();
  let now = 1_000_000;
  const service = new PlaybackService(
    h.db,
    verify,
    async () => ({ mode: "direct", assetId: "f" }),
    () => now,
  );
  const result = await service.create("m", "web", 0, owner);
  if (result.kind !== "ready") throw Error("not ready");
  return {
    service,
    id: result.session.id,
    ticket: () => result.session.mediaUrl.split("/")[3]!,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("keeps a film playing through Drive hiccups when access is renewed", async () => {
  let seconds = 0;
  const unreachable = new Set([150, 180, 270]);
  const h = await renewing(async () => {
    if (unreachable.has(seconds)) throw new Error("fetch failed");
    return source;
  });
  // A player's heartbeats, every 30 s for ten minutes.
  for (seconds = 30; seconds <= 600; seconds += 30) {
    h.advance(30000);
    await h.service.heartbeat(h.id, owner);
    await expect(
      h.service.authorizeMedia(h.ticket(), "raw"),
      `${seconds} s`,
    ).resolves.toMatchObject({ fileId: "f" });
  }
});

it("answers a heartbeat in time when Drive is slow to confirm the film", async () => {
  // The player gives a heartbeat 15 s and the edge 20 s; a Drive lookup may
  // take 30. An answer that comes too late is, to the player, a failure.
  let hanging = false;
  const h = await sessionFixture();
  let now = 1_000_000;
  const service = new PlaybackService(
    h.db,
    () => (hanging ? new Promise<never>(() => {}) : Promise.resolve(source)),
    async () => ({ mode: "direct", assetId: "f" }),
    () => now,
    50,
  );
  const result = await service.create("m", "web", 0, owner);
  if (result.kind !== "ready") throw Error("not ready");
  const beat = async () => {
    now += 30000;
    const started = Date.now();
    await service.heartbeat(result.session.id, owner);
    return Date.now() - started;
  };
  for (let i = 0; i < 4; i++) await beat();
  // 150 s in: renewal is due and Drive does not answer.
  hanging = true;
  expect(await beat()).toBeLessThan(2000);
  expect(await beat()).toBeLessThan(2000);
  // Drive answers again: access is renewed and the film plays on.
  hanging = false;
  for (let i = 0; i < 12; i++) await beat();
  await expect(
    service.authorizeMedia(result.session.mediaUrl.split("/")[3]!, "raw"),
  ).resolves.toMatchObject({ fileId: "f" });
  // Never answered before access runs out: the session ends, still in time.
  hanging = true;
  let ended = false;
  for (let i = 0; i < 10 && !ended; i++)
    await beat().catch(() => {
      ended = true;
    });
  expect(ended).toBe(true);
}, 10000);

it("ends a session at once when Drive says the film is gone", async () => {
  let gone = false;
  const h = await renewing(async () => {
    if (gone) throw new Error("Source changed or unavailable");
    return source;
  });
  for (let i = 0; i < 4; i++) {
    h.advance(30000);
    await h.service.heartbeat(h.id, owner);
  }
  gone = true;
  h.advance(30000);
  await expect(h.service.heartbeat(h.id, owner)).rejects.toThrow();
});

it("forgets the tickets of sessions that simply lapsed", async () => {
  const { service, advance } = await sessionFixture();
  for (let i = 0; i < 5; i++) {
    const result = await service.create("m", "web", 0, owner);
    expect(result.kind).toBe("ready");
    // No heartbeat: the lease runs out and the next viewer starts afresh.
    advance(130000);
  }
  expect((Reflect.get(service, "tickets") as Map<string, string>).size).toBe(1);
});

it("stops promptly while a response is still being sent", async () => {
  const h = await createHarness();
  let closed = false;
  clean.push(async () => {
    if (!closed) await h.close();
  });
  h.app.get("/slow", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/plain" });
    // Like a film being watched: bytes sent, and no end in sight.
    reply.raw.write("x");
  });
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}/slow`, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  const stopped = await Promise.race([
    h.close().then(() => "closed" as const),
    new Promise<"waiting">((resolve) =>
      setTimeout(() => resolve("waiting"), 3000),
    ),
  ]);
  closed = stopped === "closed";
  // Let a server that is still waiting go, so the test itself can end.
  controller.abort();
  await reader.cancel().catch(() => {});
  expect(stopped).toBe("closed");
});

it("records a failed request by its route and error class, never its address or data", async () => {
  const h = await createHarness();
  clean.push(h.close);
  const session = issueSession(h.db, "owner");
  h.db.prepare("INSERT INTO preferences VALUES(1,'{private-setting')").run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const failed = await h.app.inject({
    url: "/api/preferences?probe=secret-value",
    cookies: { mov_session: session.token },
  });
  expect([failed.statusCode, failed.json()]).toEqual([
    500,
    { error: "internal_error" },
  ]);
  expect(logged).toHaveBeenCalledTimes(1);
  const line = logged.mock.calls[0]!.join(" ");
  expect(line).toContain("/api/preferences");
  expect(line).toContain("SyntaxError");
  expect(line).not.toContain("secret-value");
  expect(line).not.toContain("private-setting");
  expect(line).not.toContain(session.token);
  // A refusal is the client's doing and is not recorded.
  logged.mockClear();
  expect((await h.app.inject("/api/movies")).statusCode).toBe(401);
  expect((await h.app.inject("/nothing-here")).statusCode).toBe(404);
  expect(logged).not.toHaveBeenCalled();
});

it("counts the picture credits route against the request limit", async () => {
  const h = await createHarness();
  clean.push(h.close);
  const credits = await h.app.inject("/api/artwork-credits");
  expect(credits.statusCode).toBe(401);
  expect(credits.headers["x-ratelimit-limit"]).toBe("120");
});

it("scans fully when the owner asks during a scheduled change check", async () => {
  const scans: Array<{ incremental: boolean; finish: () => void }> = [];
  const runner = scanRunner(
    {
      syncLibrary: (_folder, _signal, options = {}) =>
        new Promise((resolve) => {
          scans.push({
            incremental: Boolean(options.incremental),
            finish: () => resolve({ upserts: 0, unavailable: 0 }),
          });
        }),
    },
    new AbortController().signal,
  );
  // The schedule asks Drive what changed; the owner presses Sync meanwhile.
  runner.run("root", true);
  runner.run("root");
  runner.run("root");
  expect(scans.map((s) => s.incremental)).toEqual([true]);
  scans[0]!.finish();
  await vi.waitFor(() => expect(scans).toHaveLength(2));
  expect(scans[1]!.incremental).toBe(false);
  // One full scan answers every request made while it was owed or running.
  runner.run("root");
  scans[1]!.finish();
  await runner.idle();
  expect(scans).toHaveLength(2);
});

it("revokes a screen's credential that was approved but never collected", async () => {
  const h = await createHarness();
  clean.push(h.close);
  let now = 10_000;
  const pairing = new PairingService(h.db, Buffer.alloc(32, 3), () => now);
  const active = () =>
    (
      h.db
        .prepare("SELECT name FROM devices WHERE revoked_at IS NULL")
        .all() as Array<{ name: string }>
    ).map((d) => d.name);
  // One screen collects and acknowledges its credential; the other never does.
  const kept = pairing.create("Living room");
  pairing.approve(kept.code);
  now += 5000;
  const delivered = pairing.poll(kept.id, kept.pollSecret);
  if (delivered.state !== "approved") throw Error("not delivered");
  pairing.ack(kept.id, delivered.credential);
  const lost = pairing.create("Switched off");
  pairing.approve(lost.code);
  // While the screen may still collect it, the credential stands.
  now += 599_000;
  pairing.expire();
  expect(active().sort()).toEqual(["Living room", "Switched off"]);
  // The delivery window passes. Nobody holds that credential, and nobody can
  // collect it now, so it must not stay valid.
  now += 2_000;
  expect(() => pairing.poll(lost.id, lost.pollSecret)).toThrow();
  pairing.expire();
  expect(active()).toEqual(["Living room"]);
  // The next pairing request tidies up as well, without being asked.
  const again = pairing.create("Switched off");
  pairing.approve(again.code);
  now += 601_000;
  pairing.create("Another screen");
  expect(active()).toEqual(["Living room"]);
});

// Drive answers 403 both for "you may not read this" and for "slow down".
const limited = () =>
  new Response(
    JSON.stringify({
      error: {
        errors: [
          {
            domain: "usageLimits",
            reason: "userRateLimitExceeded",
            message: "User Rate Limit Exceeded",
          },
        ],
        code: 403,
        message: "User Rate Limit Exceeded",
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
const forbidden = () =>
  new Response(
    JSON.stringify({
      error: {
        errors: [
          {
            domain: "global",
            reason: "insufficientFilePermissions",
            message: "The user does not have sufficient permissions for file.",
          },
        ],
        code: 403,
        message: "The user does not have sufficient permissions for file.",
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );

it("reads a Drive usage limit as a request to slow down, not as a refusal", async () => {
  const file = { id: "film", name: "Film.mp4", mimeType: "video/mp4" };
  // Limited once, then answered: the lookup succeeds.
  let calls = 0;
  const recovering = createDriveClient(
    async () => "private",
    async () => (calls++ === 0 ? limited() : Response.json(file)),
    1,
  );
  expect(await recovering.get("film")).toMatchObject({ id: "film" });
  expect(calls).toBe(2);
  // Limited every time: reported as a limit, which nothing treats as a verdict.
  calls = 0;
  const throttled = createDriveClient(
    async () => "private",
    async () => {
      calls++;
      return limited();
    },
    1,
  );
  const slow = await throttled.get("film").catch((error: unknown) => error);
  expect(slow).toBeInstanceOf(DriveError);
  expect((slow as DriveError).status).toBe(429);
  expect(calls).toBe(DRIVE_RATE_LIMIT_ATTEMPTS);
  expect(sourceGone(slow)).toBe(false);
  // A real refusal is still final, at once.
  calls = 0;
  const refused = createDriveClient(
    async () => "private",
    async () => {
      calls++;
      return forbidden();
    },
  );
  const denied = await refused.get("film").catch((error: unknown) => error);
  expect((denied as DriveError).status).toBe(403);
  expect(calls).toBe(1);
  expect(sourceGone(denied)).toBe(true);
});

it("tries a film's bytes again after a Drive usage limit", async () => {
  let calls = 0;
  const reader = new DriveSourceReader(
    async () => "token",
    async () => source,
    async () =>
      calls++ === 0
        ? limited()
        : new Response("2345", {
            status: 206,
            headers: { "Content-Range": "bytes 2-5/10" },
          }),
    1,
  );
  expect(
    Buffer.from(
      await reader.block(source, 2n, 5n, new AbortController().signal),
    ).toString(),
  ).toBe("2345");
  // A refusal is not asked twice.
  calls = 0;
  const refused = new DriveSourceReader(
    async () => "token",
    async () => source,
    async () => {
      calls++;
      return forbidden();
    },
    1,
  );
  await expect(
    refused.block(source, 2n, 5n, new AbortController().signal),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("plans for the saved audio language however its code is written", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-audit-")));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const h = await sessionFixture({ preparedDir: dir, preparedFormat: "hls" });
  h.db
    .prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-f','m','f','Source','generation')",
    )
    .run();
  // An MP4 every browser plays, in Japanese first and English second. Films
  // carry three-letter codes; the settings page suggests two-letter ones.
  h.db
    .prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','source-f','probe','metadata',?)",
    )
    .run(
      JSON.stringify({
        version: PROBE_VERSION,
        generation: "generation",
        probe: {
          durationMs: 600000,
          container: "mov,mp4,m4a,3gp,3g2,mj2",
          video: {
            codec: "h264",
            pixelFormat: "yuv420p",
            width: 1280,
            height: 720,
            hdr: false,
          },
          audio: [
            { codec: "aac", channels: 2, language: "jpn", default: true },
            { codec: "aac", channels: 2, language: "eng" },
          ],
          subtitles: [],
        },
      }),
    );
  const planner = new MediaPlanner(h.db, true, dir, Date.now, {
    format: "hls",
  });
  const prefer = (audioLanguage: string) =>
    h.db
      .prepare(
        "INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify({ audioLanguage }));
  const track = async () => {
    h.db.prepare("DELETE FROM jobs").run();
    h.db.prepare("DELETE FROM prepared_assets").run();
    const plan = await planner.planPlayback(source, {
      id: "lg-c1",
      platform: "webos",
      verified: false,
    });
    expect(plan.mode).toBe("prepare");
    const job = h.db.prepare("SELECT payload FROM jobs").get() as {
      payload: string;
    };
    return (JSON.parse(job.payload) as { audio: number }).audio;
  };
  // The television gets one language per edition: the saved one.
  for (const [saved, expected] of [
    ["eng", 1],
    ["en", 1],
    ["EN", 1],
    ["ja", 0],
    ["fa", 0],
    ["original", 0],
  ] as const) {
    prefer(saved);
    expect(await track(), saved).toBe(expected);
  }
  // A browser could play this file as it is, but only in its first language.
  // A saved language further down needs an edition, not the original.
  const web = { id: "web", platform: "web", verified: false } as const;
  const capabilities = {
    video: ["h264" as const],
    audio: ["aac" as const],
    containers: ["mp4" as const],
  };
  prefer("ja");
  expect((await planner.planPlayback(source, web, { capabilities })).mode).toBe(
    "direct",
  );
  prefer("en");
  expect((await planner.planPlayback(source, web, { capabilities })).mode).toBe(
    "prepare",
  );
});

/** A film whose sound runs on for `extra` seconds after its picture ends. */
async function trailingAudio(extra: number, tracks: number) {
  const dir = await mkdtemp(join(tmpdir(), "ravan-audit-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "source.mkv");
  const idle = new AbortController().signal;
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24:duration=20",
      ...Array.from({ length: tracks }, (_, i) => [
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${440 + i * 220}:duration=${20 + extra}`,
      ]).flat(),
      "-map",
      "0:v",
      ...Array.from({ length: tracks }, (_, i) => [
        "-map",
        `${i + 1}:a`,
      ]).flat(),
      "-c:v",
      "libx264",
      "-g",
      "48",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      input,
    ],
    idle,
    30000,
  );
  return { dir, input, probe: await probeMedia(input, idle) };
}

it("prepares a film whose sound outruns its picture", async () => {
  const idle = new AbortController().signal;
  // One language: the edition is as long as the film's picture.
  const one = await trailingAudio(8, 1);
  expect(one.probe.durationMs).toBeGreaterThan(27000);
  expect(pictureMs(one.probe)).toBeLessThan(21000);
  const single = await prepareBrowser(
    one.input,
    join(one.dir, "edition"),
    one.probe,
    "auto",
    0,
    idle,
    {
      maxBytes: 64 * 1024 ** 2,
      format: "hls",
      videoCaps: ["h264"],
      verify: async () => {},
    },
  );
  expect(single.format).toBe("hls");
  // Every language: each is cut to the picture, so the streams agree.
  const two = await trailingAudio(8, 2);
  const output = join(two.dir, "edition");
  await prepareBrowser(two.input, output, two.probe, "auto", 0, idle, {
    maxBytes: 64 * 1024 ** 2,
    format: "hls",
    allAudio: true,
    videoCaps: ["h264"],
    verify: async () => {},
  });
  const picture = await validateEdition(output);
  expect(Math.abs(picture.seconds - 20)).toBeLessThan(1);
}, 60000);

it("does not take a picture's stated length on trust when it is not shorter than the film", () => {
  const probe = {
    durationMs: 60000,
    container: "matroska,webm",
    audio: [],
    subtitles: [],
  };
  const video = {
    codec: "h264",
    pixelFormat: "yuv420p",
    width: 16,
    height: 16,
    hdr: false,
  };
  expect(pictureMs({ ...probe, video })).toBe(60000);
  expect(pictureMs({ ...probe, video: { ...video, durationMs: 52000 } })).toBe(
    52000,
  );
  for (const durationMs of [0, -5, 60000, 90000, Number.NaN])
    expect(
      pictureMs({ ...probe, video: { ...video, durationMs } }),
      String(durationMs),
    ).toBe(60000);
});
