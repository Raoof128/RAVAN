import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseResult,
  lookupArtwork,
  releaseQueries,
  releaseQuery,
} from "../../apps/api/src/media/tmdb.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { createHarness } from "../fixtures/harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const token = "eyJhbGciOiJIUzI1NiJ9.test-token-of-enough-length";

it("reads a film's title and year from a release file name", () => {
  expect(releaseQuery("The.Matrix.1999.1080p.BluRay.x264-GROUP")).toEqual({
    query: "The Matrix",
    year: 1999,
  });
  expect(releaseQuery("Blade Runner 2049 (2017) 2160p UHD HDR")).toEqual({
    query: "Blade Runner 2049",
    year: 2017,
  });
  expect(releaseQuery("[Group] Spirited_Away (2001) [1080p]")).toEqual({
    query: "Spirited Away",
    year: 2001,
  });
  expect(releaseQuery("A Separation WEB-DL 720p")).toEqual({
    query: "A Separation",
  });
  // A title that is itself a year is not taken for one.
  expect(releaseQuery("1917.2019.HDR")).toEqual({ query: "1917", year: 2019 });
  // The owner's own year wins.
  expect(releaseQuery("Heat 1995", 1995)).toEqual({
    query: "Heat",
    year: 1995,
  });
  expect(releaseQuery("Heat", 1986)).toEqual({ query: "Heat", year: 1986 });
});

it("matches only when the title, and any known year, agree", () => {
  const results = [
    { id: 1, title: "The Matrix Reloaded", release_date: "2003-05-15" },
    { id: 2, title: "The Matrix", release_date: "1999-03-30" },
    { id: 3, title: "Matrix", release_date: "1973-01-01" },
  ];
  expect(chooseResult(results, { query: "The Matrix", year: 1999 })?.id).toBe(
    2,
  );
  expect(chooseResult(results, { query: "Matrix", year: 1999 })?.id).toBe(2);
  expect(
    chooseResult(results, { query: "The Matrix", year: 2010 }),
  ).toBeUndefined();
  expect(
    chooseResult(results, { query: "Matrix Resurrections" }),
  ).toBeUndefined();
  expect(
    chooseResult(
      [
        {
          id: 4,
          title: "Amélie",
          original_title: "Le Fabuleux Destin d'Amélie Poulain",
        },
      ],
      { query: "Amelie" },
    )?.id,
  ).toBe(4);
});

function fakeTmdb(options: { status?: number } = {}) {
  const calls: string[] = [];
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(4000, 1),
  ]);
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.themoviedb.org/3/search/movie?")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      if (options.status) return new Response("{}", { status: options.status });
      const query = new URL(url).searchParams.get("query");
      return Response.json({
        results:
          query === "Heat"
            ? [
                {
                  id: 949,
                  title: "Heat",
                  release_date: "1995-12-15",
                  poster_path: "/obpPQskaVpSksXzBQ2jdMRlWUq0.jpg",
                  backdrop_path: "/zMyfPUelumio3tiDKPffaUpsQTD.jpg",
                },
              ]
            : query === "Odd"
              ? [
                  {
                    id: 5,
                    title: "Odd",
                    poster_path: "/../../etc/passwd.jpg",
                    backdrop_path: null,
                  },
                ]
              : [],
      });
    }
    if (url.startsWith("https://image.tmdb.org/t/p/"))
      return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

it("fetches posters and backdrops for matched films, and only once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ravan-tmdb-"));
  dirs.push(dataDir);
  const h = await createHarness({ dataDir });
  try {
    const add = (id: string, title: string) => {
      h.db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(id, title);
      h.db
        .prepare(
          "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES(?,?,'g','1')",
        )
        .run(`f-${id}`, id);
    };
    add("heat", "Heat.1995.1080p.BluRay");
    add("unknown", "Holiday video 2019");
    add("odd", "Odd");
    const tmdb = fakeTmdb();
    const outcome = await lookupArtwork(h.db, dataDir, token, {
      fetcher: tmdb.fetcher,
    });
    expect(outcome).toMatchObject({ looked: 3, found: 1, refused: false });
    // Only TMDB's own image host, at the sizes asked for, with checked paths.
    expect(tmdb.calls.filter((u) => u.includes("image.tmdb.org"))).toEqual([
      "https://image.tmdb.org/t/p/w500/obpPQskaVpSksXzBQ2jdMRlWUq0.jpg",
      "https://image.tmdb.org/t/p/w1280/zMyfPUelumio3tiDKPffaUpsQTD.jpg",
    ]);
    expect(
      h.db
        .prepare("SELECT movie_id,kind,provider FROM artwork ORDER BY kind")
        .all(),
    ).toEqual([
      { movie_id: "heat", kind: "poster", provider: "tmdb" },
      { movie_id: "heat", kind: "still", provider: "tmdb" },
    ]);
    expect(await readdir(join(dataDir, "artwork"))).toHaveLength(2);
    // A second run looks at nothing: found, or tried recently.
    const again = fakeTmdb();
    expect(
      await lookupArtwork(h.db, dataDir, token, { fetcher: again.fetcher }),
    ).toMatchObject({ looked: 0 });
    expect(again.calls).toEqual([]);
    // The card now shows TMDB's poster, which carries its own title.
    const owner = {
      cookie: `mov_session=${issueSession(h.db, "owner").token}`,
    };
    const items = JSON.parse(
      (await h.app.inject({ url: "/api/movies", headers: owner })).body,
    ).items as Array<Record<string, unknown>>;
    const heat = items.find((m) => m.id === "heat")!;
    expect(heat.posterUrl).toMatch(/^\/api\/artwork\/[a-f0-9]{32}$/);
    expect(heat).not.toHaveProperty("posterTitled");
    // Renaming a film that was not found lets it be looked up again.
    const s = issueSession(h.db, "owner");
    const renamed = await h.app.inject({
      method: "PATCH",
      url: "/api/movies/unknown",
      headers: {
        cookie: `mov_session=${s.token}`,
        "x-csrf-token": s.csrf,
        origin: "http://localhost:4310",
      },
      payload: { title: "Heat", year: 1995 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      await lookupArtwork(h.db, dataDir, token, {
        fetcher: fakeTmdb().fetcher,
      }),
    ).toMatchObject({ looked: 1, found: 1 });
  } finally {
    await h.close();
  }
});

it("stops when TMDB refuses the token, and stays off without one", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ravan-tmdb-"));
  dirs.push(dataDir);
  const h = await createHarness({ dataDir });
  try {
    for (const id of ["a", "b"]) {
      h.db.prepare("INSERT INTO movies(id,title) VALUES(?,?)").run(id, "Heat");
      h.db
        .prepare(
          "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES(?,?,'g','1')",
        )
        .run(`f-${id}`, id);
    }
    const refused = fakeTmdb({ status: 401 });
    expect(
      await lookupArtwork(h.db, dataDir, token, { fetcher: refused.fetcher }),
    ).toMatchObject({ refused: true, found: 0 });
    expect(refused.calls).toHaveLength(1);
    // No token: the credit is absent, and no lookup is scheduled.
    const owner = {
      cookie: `mov_session=${issueSession(h.db, "owner").token}`,
    };
    expect(
      JSON.parse(
        (await h.app.inject({ url: "/api/artwork-credits", headers: owner }))
          .body,
      ),
    ).toEqual({});
  } finally {
    await h.close();
  }
  expect(() => parseConfig({ mode: "test", tmdbToken: "short" })).toThrow();
});

it("does not guess between films of the same title, and tries a year as part of the title", async () => {
  const dune = [
    { id: 1, title: "Dune", release_date: "1984-12-14" },
    { id: 2, title: "Dune", release_date: "2021-09-15" },
  ];
  expect(chooseResult(dune, { query: "Dune" })).toBeUndefined();
  expect(chooseResult(dune, { query: "Dune", year: 1984 })?.id).toBe(1);
  expect(releaseQueries("Wonder Woman 1984")).toEqual([
    { query: "Wonder Woman", year: 1984 },
    { query: "Wonder Woman 1984" },
  ]);
  // A year not yet come is part of the title, never a release year.
  expect(releaseQueries("Blade Runner 2049 1080p")).toEqual([
    { query: "Blade Runner 2049" },
  ]);
});

it("tries a film again a day after an error, and refuses an oversized answer", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ravan-tmdb-"));
  dirs.push(dataDir);
  const h = await createHarness({ dataDir });
  try {
    h.db
      .prepare("INSERT INTO movies(id,title) VALUES('heat','Heat 1995')")
      .run();
    h.db
      .prepare(
        "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('f','heat','g','1')",
      )
      .run();
    let clock = 1_000_000_000_000;
    const now = () => clock;
    const busy = fakeTmdb({ status: 503 });
    expect(
      await lookupArtwork(h.db, dataDir, token, { fetcher: busy.fetcher, now }),
    ).toMatchObject({ found: 0 });
    // The same day: left alone.
    clock += 3600000;
    expect(
      await lookupArtwork(h.db, dataDir, token, {
        fetcher: fakeTmdb().fetcher,
        now,
      }),
    ).toMatchObject({ looked: 0 });
    // The next day, with a picture streamed past the limit and no length given.
    clock += 86400000;
    const huge = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://image.tmdb.org/"))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
              for (let i = 0; i < 9; i++)
                controller.enqueue(new Uint8Array(1024 * 1024));
              controller.close();
            },
          }),
          { headers: { "content-type": "image/jpeg" } },
        );
      return fakeTmdb().fetcher(input, init);
    }) as typeof fetch;
    expect(
      await lookupArtwork(h.db, dataDir, token, { fetcher: huge, now }),
    ).toMatchObject({ looked: 1, found: 0 });
    expect(h.db.prepare("SELECT count(*) n FROM artwork").get()).toEqual({
      n: 0,
    });
  } finally {
    await h.close();
  }
});

it("schedules lookups only when a token is configured", async () => {
  const off = await createHarness();
  const on = await createHarness({ tmdbToken: token });
  try {
    expect(off.app.hasDecorator("lookupArtwork")).toBe(false);
    expect(on.app.hasDecorator("lookupArtwork")).toBe(true);
  } finally {
    await off.close();
    await on.close();
  }
});
