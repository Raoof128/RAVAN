import { TOTP, Secret } from "otpauth";
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import type { Database } from "../../packages/db/src/open.js";
import type { DriveClient } from "../../apps/api/src/drive/client.js";
it("signs in, imports, plays exact bytes, records resume and revokes cached media on logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-journey-"));
  const files = [
    {
      id: "root",
      name: "Films",
      mimeType: "application/vnd.google-apps.folder",
      parents: [],
    },
    {
      id: "film",
      name: "Fixture.mp4",
      mimeType: "video/mp4",
      parents: ["root"],
      version: "1",
      size: "10",
    },
  ];
  const client: DriveClient = {
    get: async (id) => files.find((f) => f.id === id)!,
    list: async () => ({ files: [files[1]!] }),
    startToken: async () => "one",
    changes: async () => ({ changed: false, newStartPageToken: "one" }),
  };
  const app = await buildApp(
    parseConfig({
      mode: "test",
      dataDir: dir,
      minFreeBytes: 0,
      origin: "http://localhost:4310",
      clientId: "client",
      clientSecret: "secret",
      ownerSubject: "owner",
      encryptionKey: "ab".repeat(32),
    }),
    {
      driveClient: client,
      oauthProvider: {
        authorizationUrl: ({ state }) =>
          `https://accounts.google.com/auth?state=${state}`,
        exchange: async (_c, _v, nonce) => ({
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
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
        return new Response("0123456789".slice(Number(a), Number(b) + 1), {
          status: 206,
          headers: { "content-range": `${range.replace("=", " ")}/10` },
        });
      },
    },
  );
  try {
    const start = await app.inject("/auth/google/start"),
      state = new URL(start.headers.location!).searchParams.get("state");
    const callback = await app.inject({
      url: `/auth/google/callback?code=code&state=${state}`,
      headers: {
        cookie: start.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      },
    });
    expect(callback.statusCode).toBe(302);
    let cookie = callback.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    let session = (
      await app.inject({ url: "/api/session", headers: { cookie } })
    ).json();
    expect(session.authenticated).toBe(false);
    const mfaHeaders = {
      cookie,
      origin: "http://localhost:4310",
      "x-csrf-token": session.csrfToken,
    };
    const seed = (
      await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll",
        headers: mfaHeaders,
      })
    ).json().secret;
    const verified = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      headers: mfaHeaders,
      payload: {
        code: new TOTP({ secret: Secret.fromBase32(seed) }).generate(),
      },
    });
    expect(verified.statusCode).toBe(200);
    cookie = verified.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    session = (
      await app.inject({ url: "/api/session", headers: { cookie } })
    ).json();
    expect(session.authenticated).toBe(true);
    const headers = {
      cookie,
      origin: "http://localhost:4310",
      "x-csrf-token": session.csrfToken,
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
    for (let i = 0; i < 100; i++) {
      if (
        (await app.inject({ url: "/api/library", headers })).json().state ===
        "succeeded"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const movies = (await app.inject({ url: "/api/movies", headers })).json()
      .items;
    expect(movies).toHaveLength(1);
    const db = app.getDecorator<Database>("database");
    const row = db
      .prepare("SELECT generation FROM source_files WHERE id='film'")
      .get() as { generation: string };
    db.prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-film','source-film','probe','metadata',?)",
    ).run(
      JSON.stringify({
        generation: row.generation,
        probe: {
          durationMs: 10000,
          container: "mp4",
          video: {
            codec: "h264",
            pixelFormat: "yuv420p",
            width: 160,
            height: 90,
            hdr: false,
          },
          audio: [],
          subtitles: [],
        },
      }),
    );
    const play = await app.inject({
      method: "POST",
      url: "/api/playback",
      headers,
      payload: { movieId: movies[0].id, profileId: "web", startMs: 0 },
    });
    expect(play.statusCode).toBe(200);
    const playback = play.json().session;
    const raw = await app.inject({
      url: playback.mediaUrl,
      headers: { range: "bytes=2-5" },
    });
    expect(raw.statusCode).toBe(206);
    expect(raw.body).toBe("2345");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/progress",
          headers,
          payload: {
            sessionId: playback.id,
            epoch: playback.epoch,
            sequence: 1,
            positionMs: 2000,
            ended: false,
          },
        })
      ).json().status,
    ).toBe("accepted");
    expect(
      (await app.inject({ url: "/api/movies", headers })).json().items[0]
        .resumeMs,
    ).toBe(2000);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/logout",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject(playback.mediaUrl)).statusCode).toBe(403);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
