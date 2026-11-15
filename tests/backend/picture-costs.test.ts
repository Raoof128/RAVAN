import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFixture } from "../fixtures/session-harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
import { PROBE_VERSION, type Probe } from "../../apps/worker/src/probe.js";
import { assetId } from "../../apps/worker/src/prepared-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const GiB = 1024 ** 3;
// A 1080p film no browser plays as it is, so every picture is an encode.
const probe: Probe = {
  durationMs: 2 * 3600000,
  container: "matroska,webm",
  video: {
    codec: "mpeg4",
    pixelFormat: "yuv420p",
    width: 1920,
    height: 1080,
    hdr: false,
  },
  audio: [{ codec: "ac3", channels: 6 }],
  subtitles: [],
};

async function cinema() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-costs-")));
  dirs.push(dir);
  const h = await sessionFixture({
    preparedDir: dir,
    preparedFormat: "hls",
    preparedCapacityBytes: 8 * GiB,
  });
  h.db
    .prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-f','m','f','Source','generation')",
    )
    .run();
  h.db
    .prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','source-f','probe','metadata',?)",
    )
    .run(
      JSON.stringify({
        version: PROBE_VERSION,
        generation: "generation",
        probe,
      }),
    );
  // Another film, prepared, filling most of the 8 GiB volume.
  h.db.prepare("INSERT INTO movies(id,title) VALUES('o','Other')").run();
  h.db
    .prepare(
      "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('g','o','generation','10')",
    )
    .run();
  const other = "0".repeat(64);
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,size_bytes) VALUES(?,'g','generation','auto',0,'ready',0,?)",
    )
    .run(other, String(7 * GiB));
  const owner = { cookie: `mov_session=${issueSession(h.db, "owner").token}` };
  const costs = async () => {
    const response = await h.app.inject({
      url: "/api/movies/m/pictures",
      headers: owner,
    });
    expect(response.statusCode).toBe(200);
    return Object.fromEntries(
      (
        JSON.parse(response.body).items as Array<{
          quality: string;
          state: string;
          films?: number;
        }>
      ).map((i) => [i.quality, i.films ? `${i.state}:${i.films}` : i.state]),
    );
  };
  return { h, other, costs };
}

it("says which pictures would remove other prepared films, and which are ready", async () => {
  const { h, costs } = await cinema();
  // About 1 GiB is free: every picture needs the other film's space.
  expect(await costs()).toEqual({
    auto: "removes:1",
    original: "removes:1",
    "480p": "removes:1",
    "720p": "removes:1",
    "1080p": "removes:1",
    "1440p": "removes:1",
    "2160p": "removes:1",
  });
  // A 1080p copy is ready: every name for that same picture is ready too.
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,size_bytes,format) VALUES(?,'f','generation','1080p',0,'ready',1,'1','hls')",
    )
    .run(assetId("f", "generation", "1080p", 0, false, "hls"));
  expect(await costs()).toMatchObject({
    auto: "ready",
    original: "ready",
    "1080p": "ready",
    "2160p": "ready",
    "480p": "removes:1",
  });
});

it("says a picture is too large when the space it needs is being watched", async () => {
  const { h, other, costs } = await cinema();
  h.db
    .prepare(
      "INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,epoch,lease_until,access_until,expires_at,asset_id) VALUES('s','t','o','g','generation',1,?,?,?,?)",
    )
    .run(Date.now() + 60000, Date.now() + 60000, Date.now() + 60000, other);
  const result = await costs();
  expect(result["1080p"]).toBe("too-large");
  // Even the smallest picture needs more than the gigabyte that is free.
  expect(result["480p"]).toBe("too-large");
  expect(Object.values(result)).not.toContain("removes:1");
});

it("is the owner's alone", async () => {
  const { h } = await cinema();
  expect(
    (await h.app.inject({ url: "/api/movies/m/pictures" })).statusCode,
  ).toBe(401);
});
