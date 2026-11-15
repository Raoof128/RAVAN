import {
  mkdtemp,
  mkdir,
  writeFile,
  stat,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sessionFixture } from "../fixtures/session-harness.js";
import { PlaybackService } from "../../apps/api/src/sessions/playback.js";
import { MediaPlanner } from "../../apps/api/src/media/planner.js";
import { assetId, makeRoom } from "../../apps/worker/src/prepared-store.js";
const source = { fileId: "f", generation: "generation", sizeBytes: "10" };
const profile = { id: "web", platform: "web" as const, verified: false };
it("binds prepared video and captions to session, source generation and revocation", async () => {
  const h = await sessionFixture();
  const id = "a".repeat(64);
  h.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,subtitles) VALUES(?,'f','generation','auto',0,'ready',0,?)",
    )
    .run(
      id,
      JSON.stringify([
        { file: "subtitle-0.vtt", language: "fas", label: "Persian" },
      ]),
    );
  const service = new PlaybackService(
    h.db,
    async () => source,
    async () => ({ mode: "prepared", assetId: id }),
  );
  const result = await service.create("m", "web", 0, { webHash: "owner" });
  if (result.kind !== "ready") throw Error("not ready");
  const ticket = result.session.mediaUrl.split("/")[3]!;
  expect(result.session.subtitles).toHaveLength(1);
  expect((await service.authorizeMedia(ticket, "video.mp4")).assetId).toBe(id);
  expect((await service.authorizeMedia(ticket, "subtitle-0.vtt")).assetId).toBe(
    id,
  );
  for (const path of [
    "raw",
    "subtitle-1.vtt",
    "../video.mp4",
    "other/video.mp4",
  ])
    await expect(service.authorizeMedia(ticket, path)).rejects.toThrow();
  h.db
    .prepare("UPDATE source_files SET generation='changed' WHERE id='f'")
    .run();
  await expect(
    service.authorizeMedia(ticket, "subtitle-0.vtt"),
  ).rejects.toThrow();
  h.db
    .prepare("UPDATE source_files SET generation='generation' WHERE id='f'")
    .run();
  service.stop(result.session.id, { webHash: "owner" });
  await expect(service.authorizeMedia(ticket, "video.mp4")).rejects.toThrow();
});
it("does not issue a session after eviction races with planning", async () => {
  const h = await sessionFixture();
  const service = new PlaybackService(
    h.db,
    async () => source,
    async () => ({ mode: "prepared", assetId: "missing" }),
  );
  expect((await service.create("m", "web", 0, { webHash: "owner" })).kind).toBe(
    "preparing",
  );
  expect(h.db.prepare("SELECT * FROM playback_sessions").all()).toHaveLength(0);
});
it("coalesces preparation, separates forced encodes and does not rebuild evicted background assets", async () => {
  const h = await sessionFixture();
  h.db
    .prepare(
      "INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('source-f','m','f','Source','generation')",
    )
    .run();
  const probe = {
    durationMs: 2000,
    container: "matroska",
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
  h.db
    .prepare(
      "INSERT INTO tracks(id,edition_id,kind,codec,metadata) VALUES('probe-f','source-f','probe','metadata',?)",
    )
    .run(JSON.stringify({ version: 3, generation: "generation", probe }));
  const planner = new MediaPlanner(h.db, true, "/prepared");
  const a = await planner.planPlayback(source, profile),
    b = await planner.planPlayback(source, profile);
  expect(a.assetId).toBe(b.assetId);
  const forced = await planner.planPlayback(source, profile, {
    forceCompatible: true,
  });
  expect(forced.assetId).not.toBe(a.assetId);
  expect(h.db.prepare("SELECT * FROM jobs").all()).toHaveLength(2);
  const id = assetId("f", "generation", "auto", 0);
  h.db.prepare("UPDATE prepared_assets SET state='evicted' WHERE id=?").run(id);
  h.db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(a.assetId);
  await planner.planPlayback(source, profile, {}, true);
  expect(
    h.db.prepare("SELECT state FROM jobs WHERE id=?").get(a.assetId),
  ).toEqual({ state: "completed" });
  await planner.planPlayback(source, profile);
  expect(
    h.db.prepare("SELECT state FROM jobs WHERE id=?").get(a.assetId),
  ).toEqual({ state: "queued" });
});

it("reclaims outputs orphaned between rename and database publication", async () => {
  const h = await sessionFixture(),
    dir = await mkdtemp(join(tmpdir(), "ravan-orphan-"));
  try {
    for (const [index, state] of ["preparing", "evicted", "ready"].entries()) {
      const id = String(index).repeat(64);
      await mkdir(join(dir, id));
      await writeFile(join(dir, id, "video.mp4"), "fixture");
      h.db
        .prepare(
          "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used) VALUES(?,'f','generation','auto',0,?,0)",
        )
        .run(id, state);
    }
    await makeRoom(h.db, dir, 0);
    for (const index of [0, 1])
      await expect(stat(join(dir, String(index).repeat(64)))).rejects.toThrow();
    expect((await stat(join(dir, "2".repeat(64), "video.mp4"))).isFile()).toBe(
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("serves prepared ranges and captions only through authorized tickets", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ravan-range-")));
  try {
    const h = await sessionFixture({ preparedDir: dir }),
      id = "d".repeat(64);
    await mkdir(join(dir, id));
    await writeFile(join(dir, id, "video.mp4"), "0123456789");
    await writeFile(join(dir, id, "subtitle-0.vtt"), "WEBVTT\n");
    h.db
      .prepare(
        "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used,subtitles) VALUES(?,'f','generation','auto',0,'ready',0,?)",
      )
      .run(
        id,
        JSON.stringify([
          { file: "subtitle-0.vtt", language: "en", label: "English" },
        ]),
      );
    const service = new PlaybackService(
      h.db,
      async () => source,
      async () => ({ mode: "prepared", assetId: id }),
    );
    const result = await service.create("m", "web", 0, { webHash: "owner" });
    if (result.kind !== "ready") throw Error("not ready");
    const response = await h.app.inject({
      url: result.session.mediaUrl,
      headers: { range: "bytes=2-5" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("2345");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    const caption = await h.app.inject(result.session.subtitles![0]!.url);
    expect(caption.statusCode).toBe(200);
    expect(caption.headers["content-type"]).toContain("text/vtt");
    service.stop(result.session.id, { webHash: "owner" });
    expect((await h.app.inject(result.session.mediaUrl)).statusCode).toBe(403);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
