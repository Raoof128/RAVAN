// The reading room browses by Drive folder, as the films do: a series in a
// folder ("Berserk", "Oyasumi Punpun") is one card that opens to its books.
import { expect, it } from "vitest";
import { createHarness } from "../fixtures/harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";

async function shelf(recordTree = true) {
  const h = await createHarness();
  const s = issueSession(h.db, "owner");
  const headers = { cookie: `mov_session=${s.token}` };
  if (recordTree) {
    h.db
      .prepare(
        "INSERT INTO sync_checkpoints(id,folder_id,state,counts) VALUES('library','top','succeeded','{}')",
      )
      .run();
    const add = h.db.prepare(
      "INSERT INTO library_folders(id,name,parent_id) VALUES(?,?,?)",
    );
    add.run("top", "Library", null);
    add.run("berserk", "Berserk", "top");
    add.run("deluxe", "Deluxe", "berserk");
    add.run("punpun", "Oyasumi Punpun", "top");
    add.run("pluto", "PLUTO", "top"); // films only: no card here
  }
  const book = (
    id: string,
    name: string,
    parent: string,
    position: [number, number] = [0, 0],
  ) =>
    h.db
      .prepare(
        "INSERT INTO reading_items(id,name,format,generation,size_bytes,metadata,section,fraction) VALUES(?,?,'pdf','g','10',?,?,?)",
      )
      .run(
        id,
        name,
        JSON.stringify({ id, name, parents: [parent] }),
        position[0],
        position[1],
      );
  book("b2", "Berserk Vol 02.pdf", "berserk");
  book("b1", "Berserk Vol 01.pdf", "berserk");
  book("d1", "Berserk Deluxe 01.pdf", "deluxe");
  book("p1", "Punpun 01.pdf", "punpun", [3, 0.2]);
  book("loose", "A loose book.pdf", "top");
  // The first Berserk volume has a cover; the folder card shows it.
  h.db
    .prepare(
      "INSERT INTO reading_covers(item_id,generation,picture_id,path,created_at) VALUES('b1','g',?,'x.jpg',1)",
    )
    .run("c".repeat(32));
  const get = async (query: string) =>
    h.app.inject({ url: `/api/reading?${query}`, headers });
  return { h, get };
}

it("shows the top of the reading room as its folders and its own books", async () => {
  const { h, get } = await shelf();
  try {
    const top = (await get("folder=root")).json();
    expect(top.folder).toEqual({ id: "root", name: "Library", parentId: null });
    // A folder counts the books in the folders inside it; a folder of films
    // has no card here.
    expect(top.folders).toEqual([
      {
        id: "berserk",
        name: "Berserk",
        books: 3,
        coverUrl: `/api/artwork/${"c".repeat(32)}`,
      },
      { id: "punpun", name: "Oyasumi Punpun", books: 1 },
    ]);
    expect(top.items.map((b: { id: string }) => b.id)).toEqual(["loose"]);
    // Books being read, wherever they are filed, lead the top.
    expect(top.reading.map((b: { id: string }) => b.id)).toEqual(["p1"]);
  } finally {
    await h.close();
  }
});

it("opens a folder to its books and the folders in it, with the way back", async () => {
  const { h, get } = await shelf();
  try {
    const berserk = (await get("folder=berserk")).json();
    expect(berserk.folder).toEqual({
      id: "berserk",
      name: "Berserk",
      parentId: "root",
    });
    expect(berserk.items.map((b: { id: string }) => b.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(berserk.folders).toEqual([
      { id: "deluxe", name: "Deluxe", books: 1 },
    ]);
    expect(berserk.reading).toBeUndefined();
    const deluxe = (await get("folder=deluxe")).json();
    expect(deluxe.folder).toEqual({
      id: "deluxe",
      name: "Deluxe",
      parentId: "berserk",
      parentName: "Berserk",
    });
  } finally {
    await h.close();
  }
});

it("searches a folder and the folders in it; from the top, every book", async () => {
  const { h, get } = await shelf();
  try {
    const inside = (await get("folder=berserk&q=01")).json();
    expect(inside.items.map((b: { id: string }) => b.id).sort()).toEqual([
      "b1",
      "d1",
    ]);
    expect(inside.folders).toBeUndefined();
    const everywhere = (await get("q=01")).json();
    expect(everywhere.items.map((b: { id: string }) => b.id).sort()).toEqual([
      "b1",
      "d1",
      "p1",
    ]);
    expect((await get("folder=nowhere")).statusCode).toBe(404);
    expect((await get("folder=..%2Fx")).statusCode).toBe(400);
  } finally {
    await h.close();
  }
});

it("lists every book at the top until a scan has recorded the folders", async () => {
  const { h, get } = await shelf(false);
  try {
    const top = (await get("folder=root")).json();
    expect(top.items).toHaveLength(5);
    expect(top.folders).toBeUndefined();
  } finally {
    await h.close();
  }
});
