import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import {
  ARTWORK_FILE,
  extractArtwork,
  readArtwork,
  storeArtwork,
  sweepArtwork,
} from "../../apps/worker/src/artwork.js";
import { sessionFixture } from "../fixtures/session-harness.js";
import { createHarness } from "../fixtures/harness.js";
import { hash, issueSession } from "../../apps/api/src/auth/sessions.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const idle = () => new AbortController().signal;
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "ravan-art-"));
  dirs.push(dir);
  return dir;
}
const ffmpeg = (args: string[]) =>
  runProcess("ffmpeg", ["-v", "error", "-y", ...args], idle(), 60000);
/** A picture with detail in it, so it is not mistaken for a flat frame. */
const picture = (path: string, size: string) =>
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}`,
    "-frames:v",
    "1",
    "-update",
    "1",
    path,
  ]);
const dimensions = async (path: string) =>
  JSON.parse(
    await runProcess(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        path,
      ],
      idle(),
      10000,
    ),
  ).streams[0] as { width: number; height: number };

it("takes the poster from a frame of the film when it carries no cover", async () => {
  const dir = await workspace();
  const film = join(dir, "film.mkv");
  // Three minutes: dark at first, detailed in the middle.
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:size=640x272:rate=24:duration=60",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x272:rate=24:duration=120",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    film,
  ]);
  const out = join(dir, "artwork");
  const pictures = await extractArtwork(
    film,
    undefined,
    await probeMedia(film, idle()),
    out,
    idle(),
  );
  expect(pictures.map((p) => [p.kind, p.provider]).sort()).toEqual([
    ["poster", "frame"],
    ["still", "frame"],
  ]);
  const poster = pictures.find((p) => p.kind === "poster")!;
  const still = pictures.find((p) => p.kind === "still")!;
  expect(poster.file).toMatch(ARTWORK_FILE);
  expect(await dimensions(join(out, poster.file))).toEqual({
    width: 480,
    height: 720,
  });
  // The wide frame keeps the film's shape: 2.35:1 at 1280 wide.
  expect(await dimensions(join(out, still.file))).toEqual({
    width: 1280,
    height: 544,
  });
  // The black opening was not chosen: the kept frame has detail.
  expect((await stat(join(out, still.file))).size).toBeGreaterThan(30000);
  // Only the two pictures remain; no scratch files.
  expect((await readdir(out)).sort()).toEqual([poster.file, still.file].sort());
});

it("uses the cover a Matroska film carries, and its wide cover as the still", async () => {
  const dir = await workspace();
  await picture(join(dir, "cover.jpg"), "600x900");
  await picture(join(dir, "wide.jpg"), "1920x1080");
  const film = join(dir, "film.mkv");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=10",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-attach",
    join(dir, "cover.jpg"),
    "-metadata:s:t:0",
    "mimetype=image/jpeg",
    "-metadata:s:t:0",
    "filename=cover.jpg",
    "-attach",
    join(dir, "wide.jpg"),
    "-metadata:s:t:1",
    "mimetype=image/jpeg",
    "-metadata:s:t:1",
    "filename=cover_land.jpg",
    film,
  ]);
  const out = join(dir, "artwork");
  const pictures = await extractArtwork(
    film,
    undefined,
    await probeMedia(film, idle()),
    out,
    idle(),
  );
  expect(pictures.map((p) => [p.kind, p.provider]).sort()).toEqual([
    ["poster", "cover"],
    ["still", "cover"],
  ]);
  const poster = pictures.find((p) => p.kind === "poster")!;
  expect(await dimensions(join(out, poster.file))).toEqual({
    width: 480,
    height: 720,
  });
  const still = pictures.find((p) => p.kind === "still")!;
  expect(await dimensions(join(out, still.file))).toEqual({
    width: 1280,
    height: 720,
  });
});

it("uses an MP4's cover picture, and a frame for the still", async () => {
  const dir = await workspace();
  await picture(join(dir, "cover.png"), "500x750");
  const film = join(dir, "film.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=10",
    "-i",
    join(dir, "cover.png"),
    "-map",
    "0:v",
    "-map",
    "1:v",
    "-c:v:0",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:v:1",
    "png",
    "-disposition:v:1",
    "attached_pic",
    film,
  ]);
  const out = join(dir, "artwork");
  const pictures = await extractArtwork(
    film,
    undefined,
    await probeMedia(film, idle()),
    out,
    idle(),
  );
  expect(pictures.map((p) => [p.kind, p.provider]).sort()).toEqual([
    ["poster", "cover"],
    ["still", "frame"],
  ]);
});

it("replaces a film's pictures from one source and removes the old files", async () => {
  const h = await sessionFixture();
  const dir = await workspace();
  await picture(join(dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"), "64x96");
  await picture(join(dir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg"), "64x96");
  await picture(join(dir, "cccccccccccccccccccccccccccccccc.jpg"), "64x96");
  const first = [
    {
      kind: "poster" as const,
      provider: "frame" as const,
      file: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
    },
  ];
  await storeArtwork(h.db, dir, "m", "g1", "frame", first);
  await storeArtwork(h.db, dir, "m", "g1", "tmdb", [
    {
      kind: "poster",
      provider: "tmdb",
      file: "cccccccccccccccccccccccccccccccc.jpg",
    },
  ]);
  await storeArtwork(h.db, dir, "m", "g2", "frame", [
    {
      kind: "poster",
      provider: "frame",
      file: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg",
    },
  ]);
  expect(
    h.db.prepare("SELECT provider,path FROM artwork ORDER BY provider").all(),
  ).toEqual([
    { provider: "frame", path: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg" },
    { provider: "tmdb", path: "cccccccccccccccccccccccccccccccc.jpg" },
  ]);
  expect((await readdir(dir)).sort()).toEqual([
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg",
    "cccccccccccccccccccccccccccccccc.jpg",
  ]);
  // Only names of our own shape are ever read.
  expect(await readArtwork(dir, "../mov.sqlite")).toBeUndefined();
  expect(
    await readArtwork(dir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg"),
  ).toBeInstanceOf(Buffer);
});

it("lists each film's best pictures and serves them only to the owner and paired screens", async () => {
  const dataDir = await workspace();
  const h = await createHarness({ dataDir });
  const owner = { cookie: `mov_session=${issueSession(h.db, "owner").token}` };
  const dir = join(dataDir, "artwork");
  await mkdir(dir, { recursive: true });
  const names = {
    frame: "1".repeat(32),
    cover: "2".repeat(32),
    still: "3".repeat(32),
  };
  for (const id of Object.values(names))
    await picture(join(dir, `${id}.jpg`), "64x96");
  h.db.prepare("INSERT INTO movies(id,title) VALUES('m','Film')").run();
  const add = h.db.prepare(
    "INSERT INTO artwork(id,movie_id,path,provider,kind,generation,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  add.run(names.frame, "m", `${names.frame}.jpg`, "frame", "poster", "g", 1);
  add.run(names.still, "m", `${names.still}.jpg`, "frame", "still", "g", 1);
  const card = async () =>
    (
      JSON.parse(
        (await h.app.inject({ url: "/api/movies", headers: owner })).body,
      ).items as Array<Record<string, unknown>>
    ).find((m) => m.id === "m");
  // A frame of the film: the card sets the title over it.
  expect(await card()).toMatchObject({
    posterUrl: `/api/artwork/${names.frame}`,
    posterTitled: true,
    stillUrl: `/api/artwork/${names.still}`,
  });
  // The film's own cover is preferred, and carries its own title.
  add.run(names.cover, "m", `${names.cover}.jpg`, "cover", "poster", "g", 1);
  const preferred = await card();
  expect(preferred).toMatchObject({ posterUrl: `/api/artwork/${names.cover}` });
  expect(preferred).not.toHaveProperty("posterTitled");
  const served = await h.app.inject({
    url: `/api/artwork/${names.cover}`,
    headers: owner,
  });
  expect(served.statusCode).toBe(200);
  expect(served.headers["content-type"]).toBe("image/jpeg");
  expect(served.headers["cache-control"]).toBe(
    "private, max-age=31536000, immutable",
  );
  // Without a session, or for anything but a stored id: nothing.
  expect(
    (await h.app.inject({ url: `/api/artwork/${names.cover}` })).statusCode,
  ).toBe(401);
  for (const id of ["../mov.sqlite", "x".repeat(32), "4".repeat(32)])
    expect(
      (
        await h.app.inject({
          url: `/api/artwork/${encodeURIComponent(id)}`,
          headers: owner,
        })
      ).statusCode,
      id,
    ).toBe(404);
  // A paired TV may read pictures with its own credential, and nothing more.
  h.db
    .prepare("INSERT INTO devices(id,name,token_hash) VALUES('tv','TV',?)")
    .run(hash("d".repeat(43)));
  const tv = { authorization: `Bearer ${"d".repeat(43)}` };
  expect(
    (await h.app.inject({ url: `/api/artwork/${names.cover}`, headers: tv }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await h.app.inject({
        method: "DELETE",
        url: `/api/artwork/${names.cover}`,
        headers: tv,
      })
    ).statusCode,
  ).toBe(403);
  // Other answers are still never cached.
  expect(
    (await h.app.inject({ url: "/api/movies", headers: owner })).headers[
      "cache-control"
    ],
  ).toBe("no-store");
  await h.close();
});

it("removes picture files nothing refers to, but not recent ones", async () => {
  const h = await sessionFixture();
  const dir = await workspace();
  for (const name of [
    "dddddddddddddddddddddddddddddddd.jpg",
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.jpg",
    ".0123456789abcdef.tmp",
    "keep-me.txt",
  ])
    await picture(
      join(dir, name.endsWith(".txt") ? name.replace(".txt", ".jpg") : name),
      "64x96",
    ).catch(() => {});
  await writeFile(join(dir, "keep-me.txt"), "not ours");
  h.db
    .prepare(
      "INSERT INTO artwork(id,movie_id,path,provider,kind,generation,created_at) VALUES('d','m','dddddddddddddddddddddddddddddddd.jpg','frame','poster','g',1)",
    )
    .run();
  // Nothing is old enough yet.
  expect(await sweepArtwork(h.db, dir)).toBe(0);
  const later = Date.now() + 2 * 3600000;
  expect(await sweepArtwork(h.db, dir, later)).toBeGreaterThanOrEqual(1);
  const left = await readdir(dir);
  expect(left).toContain("dddddddddddddddddddddddddddddddd.jpg");
  expect(left).toContain("keep-me.txt");
  expect(left).not.toContain("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.jpg");
});

it("fails, to be tried again, when the film cannot be read at all", async () => {
  const dir = await workspace();
  const film = join(dir, "film.mkv");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=10",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    film,
  ]);
  const probe = await probeMedia(film, idle());
  await rm(film);
  await expect(
    extractArtwork(film, undefined, probe, join(dir, "out"), idle()),
  ).rejects.toThrow("unreadable");
  expect(await readdir(join(dir, "out"))).toEqual([]);
});
