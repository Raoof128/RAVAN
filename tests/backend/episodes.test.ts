// Next episode: which film follows this one, read from the Drive file names
// the owner gives their series ("Fire Force - S03E01.mkv"), and titles that
// follow those names when the owner renames a file in Drive.
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { LibrarySync } from "../../apps/api/src/drive/sync.js";
import type {
  DriveClient,
  DriveFile,
} from "../../apps/api/src/drive/client.js";
import { parseEpisode } from "../../packages/contracts/src/episodes.js";
import { createHarness } from "../fixtures/harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});

it("reads season and episode numbers from the names series are given", () => {
  expect(parseEpisode("Fire Force - S03E01.mkv")).toEqual({
    season: 3,
    episode: 1,
  });
  expect(parseEpisode("Pluto - s01e08")).toEqual({ season: 1, episode: 8 });
  expect(parseEpisode("Show S1 E12.mp4")).toEqual({ season: 1, episode: 12 });
  expect(parseEpisode("Show 2x05.mkv")).toEqual({ season: 2, episode: 5 });
  expect(parseEpisode("Show - Episode 10.mkv")).toEqual({ episode: 10 });
  expect(parseEpisode("Show Ep. 3.mkv")).toEqual({ episode: 3 });
  // Films: a year, a resolution or a codec is not an episode.
  for (const film of [
    "Her (2013).mp4",
    "Spider-Man - Brand New Day (2026).mkv",
    "[Rec] (2007).mp4",
    "Obsession.2026.1080p.AMZN.WEB-DL.mp4",
    "Movie.x264.1920x1080.mkv",
    "Demon Slayer - Infinity Castle (2025).mkv",
  ])
    expect(parseEpisode(film), film).toBeUndefined();
});

async function catalogue() {
  const h = await createHarness();
  const s = issueSession(h.db, "owner");
  const headers = {
    cookie: `mov_session=${s.token}`,
    origin: "http://localhost:4310",
    "x-csrf-token": s.csrf,
  };
  const add = h.db.prepare(
    "INSERT INTO library_folders(id,name,parent_id) VALUES(?,?,?)",
  );
  add.run("root", "Movies", null);
  add.run("ff3", "Fire Force - Season 3", "root");
  add.run("anime", "Anime", "root");
  const film = (
    id: string,
    file: string,
    parent: string,
    available = 1,
    title = file.replace(/\.[^.]+$/, ""),
  ) => {
    h.db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(id, title);
    h.db
      .prepare(
        "INSERT INTO source_files(id,movie_id,generation,size_bytes,name,parent_id,available) VALUES(?,?,'g','10',?,?,?)",
      )
      .run(`src-${id}`, id, file, parent, available);
  };
  return { h, headers, film };
}

it("names the next episode in the same folder, in episode order", async () => {
  const { h, headers, film } = await catalogue();
  try {
    // Stored out of order, and with an old title on one: the file name rules.
    film("e10", "Fire Force - S03E10.mkv", "ff3");
    film("e2", "Fire Force - S03E02.mkv", "ff3");
    film("e1", "Fire Force - S03E01.mkv", "ff3", 1, "[Old] Enen - 01");
    film("e3", "Fire Force - S03E03.mkv", "ff3", 0); // gone from Drive
    film("e9", "Fire Force - S03E09.mkv", "ff3");
    const get = async (id: string) =>
      (await h.app.inject({ url: `/api/movies/${id}`, headers })).json();

    const first = await get("e1");
    expect(first.episode).toMatchObject({
      season: 3,
      episode: 1,
      index: 1,
      count: 4,
      folder: { id: "ff3", name: "Fire Force - Season 3" },
      next: { id: "e2", season: 3, episode: 2, title: "Fire Force - S03E02" },
    });
    // An episode no longer in Drive is skipped; 10 follows 9, not 1.
    expect((await get("e2")).episode.next.id).toBe("e9");
    expect((await get("e9")).episode.next.id).toBe("e10");
    const last = await get("e10");
    expect(last.episode).toMatchObject({ index: 4, count: 4 });
    expect(last.episode.next).toBeUndefined();
  } finally {
    await h.close();
  }
});

it("offers no next episode for films that are not episodes", async () => {
  const { h, headers, film } = await catalogue();
  try {
    film("her", "Her (2013).mp4", "anime");
    film("rec", "[Rec] (2007).mp4", "anime");
    film("lone", "Fire Force - S03E01.mkv", "root");
    const her = (
      await h.app.inject({ url: "/api/movies/her", headers })
    ).json();
    expect(her.episode).toBeUndefined();
    // One episode alone in a folder still says where it stands.
    const lone = (
      await h.app.inject({ url: "/api/movies/lone", headers })
    ).json();
    expect(lone.episode).toMatchObject({ index: 1, count: 1 });
    expect(lone.episode.next).toBeUndefined();
  } finally {
    await h.close();
  }
});

it("plays the next episode on its own unless the owner turns it off", async () => {
  const { h, headers } = await catalogue();
  try {
    const read = async () =>
      (await h.app.inject({ url: "/api/preferences", headers })).json();
    expect((await read()).autoplayNext).toBe(true);
    const saved = await h.app.inject({
      method: "PUT",
      url: "/api/preferences",
      headers,
      payload: { ...(await read()), autoplayNext: false },
    });
    expect(saved.statusCode).toBe(200);
    expect((await read()).autoplayNext).toBe(false);
  } finally {
    await h.close();
  }
});

const video = (id: string, name: string, parent: string): DriveFile => ({
  id,
  name,
  mimeType: "video/mp4",
  parents: [parent],
  size: "10",
  version: "1",
});
function client(files: DriveFile[]): DriveClient {
  return {
    get: async (id) => ({ ...files.find((f) => f.id === id)! }),
    list: async (parent) => ({
      files: files.filter((f) => f.parents?.includes(parent)),
    }),
    startToken: async () => "token",
    changes: async () => ({ changed: false, newStartPageToken: "token" }),
  };
}

it("keeps a film's title with its Drive name until the owner edits it in RAVAN", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-episodes-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const files: DriveFile[] = [
    {
      id: "root",
      name: "Movies",
      mimeType: "application/vnd.google-apps.folder",
      parents: [],
    },
    video("a", "[Kayoanime] Enen no Shouboutai - S03E01.mkv", "root"),
    video("b", "Her.2013.1080p.BluRay.x264.YIFY.mp4", "root"),
  ];
  const sync = new LibrarySync(db, client(files));
  await sync.syncLibrary("root", new AbortController().signal);
  const title = (id: string) =>
    (
      db
        .prepare(
          "SELECT m.title FROM movies m JOIN source_files s ON s.movie_id=m.id WHERE s.id=?",
        )
        .get(id) as { title: string }
    ).title;
  expect(title("a")).toBe("[Kayoanime] Enen no Shouboutai - S03E01");
  // The owner renames both in Drive, and edits b's title in RAVAN first.
  db.prepare(
    "UPDATE movies SET title='Her',title_edited=1 WHERE id=(SELECT movie_id FROM source_files WHERE id='b')",
  ).run();
  files[1]!.name = "Fire Force - S03E01.mkv";
  files[2]!.name = "Her (2013).mp4";
  await sync.syncLibrary("root", new AbortController().signal);
  expect(title("a")).toBe("Fire Force - S03E01");
  expect(title("b")).toBe("Her");
});

it("treats titles already edited in RAVAN as the owner's after the upgrade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-episodes-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  // Rows as an older release left them: an edit in RAVAN stamps
  // milliseconds, an import's default is seconds. Then the migration's own
  // statements, after the column it adds.
  db.prepare(
    "INSERT INTO movies(id,title,updated_at,title_edited) VALUES('imported','x',1763000000,0),('edited','y',1763000000000,0)",
  ).run();
  const sql = readFileSync(
    new URL(
      "../../packages/db/migrations/012_title_follows_drive.sql",
      import.meta.url,
    ),
    "utf8",
  );
  db.exec(sql.replace(/ALTER TABLE[^;]*;/g, ""));
  expect(
    db.prepare("SELECT id,title_edited FROM movies ORDER BY id").all(),
  ).toEqual([
    { id: "edited", title_edited: 1 },
    { id: "imported", title_edited: 0 },
  ]);
});

it("gives films renamed in Drive before the upgrade their new names at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-episodes-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  // The scans that saw these renames kept the old titles; the unattended
  // schedule will not look again until Drive changes.
  const film = (
    id: string,
    title: string,
    names: Array<[string, number]>,
    edited = 0,
  ) => {
    db.prepare("INSERT INTO movies(id,title,title_edited) VALUES(?,?,?)").run(
      id,
      title,
      edited,
    );
    names.forEach(([name, available], i) =>
      db
        .prepare(
          "INSERT INTO source_files(id,movie_id,generation,size_bytes,name,available) VALUES(?,?,'g','1',?,?)",
        )
        .run(`${id}-${i}`, id, name, available),
    );
  };
  film("ff", "[Kayoanime] Enen no Shouboutai - S03E01", [
    ["Fire Force - S03E01.mkv", 1],
  ]);
  film("her", "Her.2013.1080p.BluRay.x264.YIFY", [["Her (2013).mp4", 1]]);
  film("dots", "old", [["Mr. Nobody v1.2.mkv", 1]]);
  film("mine", "My own title", [["Something.mkv", 1]], 1);
  film("two", "Two sources", [
    ["A.mkv", 1],
    ["B.mkv", 1],
  ]);
  film("gone", "Gone", [["Renamed.mkv", 0]]);
  db.prepare(
    "INSERT INTO artwork_lookups(movie_id,tried_at,outcome) VALUES('ff',1,'not_found'),('mine',1,'not_found')",
  ).run();
  const sql = readFileSync(
    new URL(
      "../../packages/db/migrations/012_title_follows_drive.sql",
      import.meta.url,
    ),
    "utf8",
  );
  db.exec(sql.replace(/ALTER TABLE[^;]*;/g, ""));
  const titles = Object.fromEntries(
    (
      db.prepare("SELECT id,title FROM movies").all() as Array<{
        id: string;
        title: string;
      }>
    ).map((r) => [r.id, r.title]),
  );
  expect(titles).toEqual({
    ff: "Fire Force - S03E01",
    her: "Her (2013)",
    dots: "Mr. Nobody v1.2",
    mine: "My own title",
    two: "Two sources",
    gone: "Gone",
  });
  // A new name deserves another look for a poster, as in a scan.
  expect(
    db.prepare("SELECT movie_id FROM artwork_lookups ORDER BY movie_id").all(),
  ).toEqual([{ movie_id: "mine" }]);
});

it("marks a title edited through the API as the owner's", async () => {
  const { h, headers, film } = await catalogue();
  try {
    film("e1", "Fire Force - S03E01.mkv", "ff3");
    const edited = await h.app.inject({
      method: "PATCH",
      url: "/api/movies/e1",
      headers,
      payload: { title: "Fire Force, the beginning" },
    });
    expect(edited.statusCode).toBe(200);
    expect(
      h.db.prepare("SELECT title_edited FROM movies WHERE id='e1'").get(),
    ).toEqual({ title_edited: 1 });
  } finally {
    await h.close();
  }
});
