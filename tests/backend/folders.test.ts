import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { LibrarySync } from "../../apps/api/src/drive/sync.js";
import type {
  DriveClient,
  DriveFile,
} from "../../apps/api/src/drive/client.js";
import { createHarness } from "../fixtures/harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const folder = "application/vnd.google-apps.folder";
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

it("records the library's folders with their names when it scans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-folders-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const files: DriveFile[] = [
    { id: "root", name: "Movies", mimeType: folder, parents: [] },
    { id: "pluto", name: "Pluto", mimeType: folder, parents: ["root"] },
    { id: "s1", name: "Season 1", mimeType: folder, parents: ["pluto"] },
    video("e1", "Pluto S01E01.mkv", "s1"),
    video("film", "Night Transit.mp4", "root"),
  ];
  const sync = new LibrarySync(db, client(files));
  await sync.syncLibrary("root", new AbortController().signal);
  expect(
    db
      .prepare("SELECT id,name,parent_id FROM library_folders ORDER BY id")
      .all(),
  ).toEqual([
    { id: "pluto", name: "Pluto", parent_id: "root" },
    { id: "root", name: "Movies", parent_id: null },
    { id: "s1", name: "Season 1", parent_id: "pluto" },
  ]);
  // A folder renamed in Drive is shown with its new name after the next scan.
  files[1]!.name = "Pluto (2023)";
  await sync.syncLibrary("root", new AbortController().signal);
  expect(
    db.prepare("SELECT name FROM library_folders WHERE id='pluto'").get(),
  ).toEqual({ name: "Pluto (2023)" });
});

it("rescans in full once when a library was published before folders were recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-folders-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  clean.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const files: DriveFile[] = [
    { id: "root", name: "Movies", mimeType: folder, parents: [] },
    { id: "pluto", name: "Pluto", mimeType: folder, parents: ["root"] },
    video("e1", "Pluto 1.mkv", "pluto"),
  ];
  const sync = new LibrarySync(db, client(files));
  await sync.syncLibrary("root", new AbortController().signal);
  // As an earlier release left it: a fresh, complete scan but no folder tree.
  db.prepare("DELETE FROM library_folders").run();
  await sync.syncLibrary("root", new AbortController().signal, {
    incremental: true,
  });
  expect(db.prepare("SELECT COUNT(*) n FROM library_folders").get()).toEqual({
    n: 2,
  });
});

it("browses the library by folder, with folders as cards and films by title", async () => {
  const h = await createHarness();
  try {
    const s = issueSession(h.db, "owner"),
      headers = { cookie: `mov_session=${s.token}` };
    const db = h.db;
    db.prepare(
      "INSERT INTO sync_checkpoints(id,folder_id,state,counts) VALUES('library','root','succeeded','{}')",
    ).run();
    // Before a scan has recorded folders, the top of the library is all of it.
    const film = (id: string, title: string, parent: string) => {
      db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(id, title);
      db.prepare(
        "INSERT INTO source_files(id,movie_id,generation,size_bytes,parent_id,available) VALUES(?,?,'g','10',?,1)",
      ).run(`src-${id}`, id, parent);
    };
    film("top", "Night Transit", "root");
    film("e2", "Pluto 02", "pluto");
    film("e1", "Pluto 01", "pluto");
    film("x1", "Extra", "s1");
    const flat = await h.app.inject({
      url: "/api/movies?folder=root",
      headers,
    });
    expect(flat.statusCode).toBe(200);
    expect(flat.json().items).toHaveLength(4);
    expect(flat.json().folders).toBeUndefined();

    const add = db.prepare(
      "INSERT INTO library_folders(id,name,parent_id) VALUES(?,?,?)",
    );
    add.run("root", "Movies", null);
    add.run("pluto", "Pluto", "root");
    add.run("s1", "Extras", "pluto");
    add.run("subs", "Subtitles", "root");
    db.prepare(
      "INSERT INTO progress(movie_id,session_id,epoch,sequence,position_ms,updated_at) VALUES('e2','x',1,1,60000,1)",
    ).run();

    const top = (
      await h.app.inject({ url: "/api/movies?folder=root", headers })
    ).json();
    expect(top.folder).toEqual({ id: "root", name: "Movies", parentId: null });
    expect(top.items.map((m: { id: string }) => m.id)).toEqual(["top"]);
    // Pluto counts the films in its own folders; an empty folder is not shown.
    expect(top.folders).toEqual([{ id: "pluto", name: "Pluto", films: 3 }]);
    // A film being watched inside a folder still leads the top of the library.
    expect(top.resume.map((m: { id: string }) => m.id)).toEqual(["e2"]);

    const pluto = (
      await h.app.inject({ url: "/api/movies?folder=pluto", headers })
    ).json();
    expect(pluto.folder).toEqual({
      id: "pluto",
      name: "Pluto",
      parentId: "root",
    });
    expect(pluto.items.map((m: { id: string }) => m.id)).toEqual(["e1", "e2"]);
    expect(pluto.folders).toEqual([{ id: "s1", name: "Extras", films: 1 }]);
    expect(pluto.resume).toBeUndefined();

    const extras = (
      await h.app.inject({ url: "/api/movies?folder=s1", headers })
    ).json();
    expect(extras.folder).toMatchObject({
      parentId: "pluto",
      parentName: "Pluto",
    });
    // A search inside a folder looks only there.
    expect(
      (
        await h.app.inject({ url: "/api/movies?folder=pluto&q=02", headers })
      ).json().items,
    ).toHaveLength(1);
    expect(
      (
        await h.app.inject({
          url: "/api/movies?folder=pluto&q=Night",
          headers,
        })
      ).json().items,
    ).toEqual([]);
    // Without a folder, the whole library is listed as before.
    expect(
      (await h.app.inject({ url: "/api/movies", headers })).json().items,
    ).toHaveLength(4);
    expect(
      (await h.app.inject({ url: "/api/movies?folder=nope", headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app.inject({ url: "/api/movies?folder=a%2Fb", headers }))
        .statusCode,
    ).toBe(400);
  } finally {
    await h.close();
  }
});

it("pages a folder's films by title with a cursor it checks", async () => {
  const h = await createHarness();
  try {
    const s = issueSession(h.db, "owner"),
      headers = { cookie: `mov_session=${s.token}` };
    const db = h.db;
    db.prepare(
      "INSERT INTO sync_checkpoints(id,folder_id,state,counts) VALUES('library','root','succeeded','{}')",
    ).run();
    db.prepare(
      "INSERT INTO library_folders(id,name,parent_id) VALUES('root','Movies',NULL)",
    ).run();
    for (let n = 45; n > 0; n--) {
      const id = `m${n}`;
      db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(
        id,
        `Episode ${String(n).padStart(2, "0")}`,
      );
      db.prepare(
        "INSERT INTO source_files(id,movie_id,generation,size_bytes,parent_id) VALUES(?,?,'g','1','root')",
      ).run(`s${n}`, id);
    }
    const first = (
      await h.app.inject({ url: "/api/movies?folder=root", headers })
    ).json();
    expect(first.items).toHaveLength(40);
    expect(first.items[0].title).toBe("Episode 01");
    const second = (
      await h.app.inject({
        url: `/api/movies?folder=root&cursor=${first.nextCursor}`,
        headers,
      })
    ).json();
    expect(second.items.map((m: { title: string }) => m.title)).toEqual([
      "Episode 41",
      "Episode 42",
      "Episode 43",
      "Episode 44",
      "Episode 45",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.folders).toBeUndefined();
    const forged = Buffer.from('["x",1]').toString("base64url");
    expect(
      (
        await h.app.inject({
          url: `/api/movies?folder=root&cursor=${forged}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await h.close();
  }
});
