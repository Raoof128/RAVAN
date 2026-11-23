import {
  advanceNativePreparations,
  preparationStatus,
  rememberPreparation,
} from "../../apps/api/src/media/native-preparations.js";
import { openDatabase } from "../../packages/db/src/open.js";
import { MediaPlanner } from "../../apps/api/src/media/planner.js";
import { PROBE_VERSION } from "../../apps/worker/src/probe.js";
import Sqlite from "better-sqlite3";
import { migrate } from "../../packages/db/src/migrate.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sessionFixture } from "../fixtures/session-harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import { PairingService } from "../../apps/api/src/sessions/pairing.js";
import {
  discoveryV1Schema,
  nativePreparationSchema,
} from "../../packages/contracts/src/schemas.js";

function example(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../packages/contracts/fixtures/apple-v1/" + name + ".json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

it("advertises one installation without exposing any owner data", async () => {
  const h = await sessionFixture({
    origin: "https://cinema.example",
    ownerSubject: "fixture-owner",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    encryptionKey: "ab".repeat(32),
  });
  const response = await h.app.inject("/api/capabilities");
  expect(response.statusCode).toBe(200);
  const capabilities = discoveryV1Schema.parse(response.json());
  expect(response.json()).toEqual({
    ...capabilities,
    mediaOrigins: ["https://cinema.example"],
  });
  expect((await h.app.inject("/api/capabilities")).json().instanceId).toBe(
    capabilities.instanceId,
  );
  expect(discoveryV1Schema.safeParse(example("discovery")).success).toBe(true);
  expect(
    discoveryV1Schema.safeParse(example("unsupported-major")).success,
  ).toBe(false);
  expect(
    nativePreparationSchema.safeParse(example("preparation-status")).success,
  ).toBe(true);
  expect(example("preparing").preparationId).toMatch(/^[a-f0-9]{64}$/);
  const unconfigured = await sessionFixture();
  expect((await unconfigured.app.inject("/api/capabilities")).statusCode).toBe(
    503,
  );
});

it("retains the old device's grants and only revokes the requesting device", async () => {
  const h = await sessionFixture({ encryptionKey: "ab".repeat(32) });
  const pair = new PairingService(h.db, Buffer.alloc(32, 0xab));
  const owner = issueSession(h.db, "owner");
  const headers = {
    cookie: "mov_session=" + owner.token,
    origin: "http://localhost:4310",
    "x-csrf-token": owner.csrf,
  };
  const grant = async (watchlistWrite?: boolean) => {
    const challenge = pair.create("Screen");
    const result = await h.app.inject({
      method: "POST",
      url: "/api/pairing/approve",
      headers,
      payload: { code: challenge.code, watchlistWrite },
    });
    expect(result.statusCode).toBe(204);
    const approved = pair.poll(challenge.id, challenge.pollSecret);
    if (approved.state !== "approved") throw Error("fixture pairing failed");
    return { authorization: "Bearer " + approved.credential };
  };
  const old = await grant();
  const writer = await grant(true);
  const save = (headers: { authorization: string }) =>
    h.app.inject({
      method: "PUT",
      url: "/api/watchlist/m",
      headers,
      payload: { saved: true },
    });
  expect((await save(old)).statusCode).toBe(403);
  expect(
    (await h.app.inject({ url: "/api/session", headers: old })).json()
      .permissions,
  ).toEqual([]);
  expect(
    (await h.app.inject({ url: "/api/session", headers: writer })).json()
      .permissions,
  ).toEqual(["watchlist:write"]);
  expect(
    (await Promise.all([save(writer), save(writer)])).map((r) => r.statusCode),
  ).toEqual([204, 204]);
  expect(h.db.prepare("SELECT movie_id FROM watchlist").all()).toEqual([
    { movie_id: "m" },
  ]);
  expect(
    (
      await h.app.inject({
        method: "DELETE",
        url: "/api/devices/self",
        headers: writer,
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await h.app.inject({ url: "/api/session", headers: writer })).json()
      .authenticated,
  ).toBe(false);
  expect(
    (await h.app.inject({ url: "/api/session", headers: old })).json()
      .authenticated,
  ).toBe(true);
});

it("paginates tied resume positions and skips ended, stale and ambiguous cuts", async () => {
  const h = await sessionFixture();
  h.db.transaction(() => {
    for (let index = 0; index < 44; index++) {
      const id = "film-" + String(index).padStart(2, "0");
      h.db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(id, id);
      h.db
        .prepare(
          "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES(?,?,'g','10')",
        )
        .run(id, id);
      h.db
        .prepare(
          "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES(?,?,?,'Original','g')",
        )
        .run(id, id, id);
      h.db
        .prepare(
          "INSERT INTO progress VALUES(?, 'fixture',1,1,25339.75,?,12345)",
        )
        .run(id, Number(index === 43));
    }
    h.db.exec(
      "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('another-cut','film-42','g','10'); INSERT INTO progress_editions VALUES('film-41','film-41','stale')",
    );
  })();
  const headers = {
    cookie: "mov_session=" + issueSession(h.db, "owner").token,
  };
  const first = (
    await h.app.inject({ url: "/api/continue-watching", headers })
  ).json();
  expect(first.items).toHaveLength(40);
  expect(first.items[0]).toMatchObject({
    id: "film-00",
    resumeMs: 25340,
    lastPlayedAtMs: 12345,
  });
  const second = (
    await h.app.inject({
      url: "/api/continue-watching?cursor=" + first.nextCursor,
      headers,
    })
  ).json();
  expect(second.items.map((i: { id: string }) => i.id)).toEqual(["film-40"]);
  expect(second.nextCursor).toBe(null);
  expect(
    (await h.app.inject({ url: "/api/continue-watching?cursor=bad", headers }))
      .statusCode,
  ).toBe(400);
});

it("upgrades a populated version 4 cinema and keeps its identity on a second migration", () => {
  const db = new Sqlite(":memory:");
  try {
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (const [index, file] of [
      "001_initial.sql",
      "002_ticket_overlap.sql",
      "003_mfa.sql",
      "004_prepared.sql",
    ].entries()) {
      db.exec(
        readFileSync(
          new URL("../../packages/db/migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
      db.prepare("INSERT INTO schema_migrations VALUES(?,0)").run(index + 1);
    }
    db.exec(`
      INSERT INTO devices(id,name,token_hash) VALUES('tv','Legacy screen','hashed');
      INSERT INTO movies(id,title) VALUES('m','Fixture');
      INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('f','m','old','10');
      INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('cut','m','f','Original','old');
      INSERT INTO watchlist VALUES('m',1);
      INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,device_id,epoch,lease_until,access_until,expires_at)
      VALUES('session','ticket','m','f','old','tv',1,0,0,0);
      INSERT INTO progress VALUES ('m','session',1,1,2000,0,1);
      INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used) VALUES('fixture','f','old','auto',0,'ready',1);
    `);
    migrate(db);
    const id = db.prepare("SELECT id FROM server_identity").get();
    migrate(db);
    expect(db.prepare("SELECT id FROM server_identity").get()).toEqual(id);
    expect(
      db
        .prepare("SELECT watchlist_write,reading,revoked_at FROM devices")
        .get(),
    ).toEqual({ watchlist_write: 0, reading: 0, revoked_at: null });
    expect(db.prepare("SELECT * FROM progress_editions").get()).toEqual({
      movie_id: "m",
      edition_id: "cut",
      generation: "old",
    });
    expect(db.prepare("SELECT position_ms FROM progress").get()).toEqual({
      position_ms: 2000,
    });
    expect(db.prepare("SELECT state FROM prepared_assets").get()).toEqual({
      state: "ready",
    });
    expect(db.prepare("SELECT movie_id FROM watchlist").get()).toEqual({
      movie_id: "m",
    });
  } finally {
    db.close();
  }
});

it("reopens a pending preparation after restart and advances a cold probe without issuing a lease", async () => {
  const h = await sessionFixture();
  const source = { fileId: "f", generation: "generation", sizeBytes: "10" };
  const profile = {
    id: "apple-sdr-v1",
    platform: "apple" as const,
    verified: false,
  };
  const principal = { deviceId: "screen" };
  h.db.exec(
    "INSERT INTO devices(id,name,token_hash) VALUES('screen','Fixture','hashed'); INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('cut','m','f','Original','generation')",
  );
  const planner = new MediaPlanner(h.db, true, "/fixture");
  const initial = await planner.planPlayback(source, profile);
  expect(initial.mode).toBe("prepare");
  const id = rememberPreparation(
    h.db,
    principal,
    "m",
    "cut",
    source,
    {},
    initial.assetId,
  );
  const reopened = openDatabase(h.db.name);
  try {
    expect(preparationStatus(reopened, principal, id)).toEqual({
      state: "queued",
    });
    reopened
      .prepare(
        "UPDATE jobs SET state='failed',error_code='media_failed' WHERE id=?",
      )
      .run(initial.assetId);
    expect(preparationStatus(reopened, principal, id)).toEqual({
      state: "failed",
      reasonCode: "media_failed",
    });
    reopened
      .prepare("UPDATE jobs SET state='completed',error_code=NULL WHERE id=?")
      .run(initial.assetId);
    const probe = {
      durationMs: 8000,
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
    };
    reopened
      .prepare(
        "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','cut','probe','metadata',?)",
      )
      .run(
        JSON.stringify({
          version: PROBE_VERSION,
          generation: "generation",
          probe,
        }),
      );
    expect(preparationStatus(reopened, principal, id)?.state).toBe("probing");
    await advanceNativePreparations(
      reopened,
      new MediaPlanner(reopened, true, "/fixture"),
    );
    expect(preparationStatus(reopened, principal, id)).toEqual({
      state: "ready",
    });
    expect(
      reopened.prepare("SELECT count(*) n FROM playback_sessions").get(),
    ).toEqual({ n: 0 });
  } finally {
    reopened.close();
  }
});
