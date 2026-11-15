import { expect, it } from "vitest";
import { createHarness } from "../fixtures/harness.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
it("browses Unicode titles, escapes searches and validates cursor pagination", async () => {
  const h = await createHarness();
  try {
    const s = issueSession(h.db, "owner"),
      headers = { cookie: `mov_session=${s.token}` };
    h.db
      .prepare("INSERT INTO movies(id,title) VALUES(?,?)")
      .run("m", "فیلم <img onerror=x>");
    const list = await h.app.inject({ url: "/api/movies", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].title).toContain("فیلم");
    expect(list.json().items[0].available).toBe(false);
    expect(list.json().items[0].posterUrl).toBeUndefined();
    expect(
      (
        await h.app.inject({
          url: "/api/movies?q=" + encodeURIComponent("%' OR 1=1 --"),
          headers,
        })
      ).json().items,
    ).toEqual([]);
    expect(
      (await h.app.inject({ url: "/api/movies?cursor=%%%25", headers }))
        .statusCode,
    ).toBe(400);
  } finally {
    await h.close();
  }
});
it("saves metadata, watchlist and preferences under CSRF enforcement", async () => {
  const h = await createHarness();
  try {
    const s = issueSession(h.db, "owner"),
      headers = {
        cookie: `mov_session=${s.token}`,
        origin: "http://localhost:4310",
        "x-csrf-token": s.csrf,
      };
    h.db.prepare("INSERT INTO movies(id,title) VALUES('m','Original')").run();
    expect(
      (
        await h.app.inject({
          method: "PATCH",
          url: "/api/movies/m",
          headers,
          payload: {
            title: "Corrected",
            description: "Personal notes",
            year: 2025,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/api/watchlist/m",
          headers,
          payload: { saved: true },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await h.app.inject({ url: "/api/movies?saved=true", headers })).json()
        .items,
    ).toHaveLength(1);
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/api/preferences",
          headers,
          payload: {
            audioLanguage: "fa",
            subtitleLanguage: "en",
            reducedMotion: true,
          },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await h.close();
  }
});
it("rejects remote artwork metadata and keeps local details without any metadata provider", async () => {
  const h = await createHarness();
  try {
    const s = issueSession(h.db, "owner"),
      headers = {
        cookie: `mov_session=${s.token}`,
        origin: "http://localhost:4310",
        "x-csrf-token": s.csrf,
      };
    h.db
      .prepare("INSERT INTO movies(id,title) VALUES('m','Local title')")
      .run();
    expect(
      (
        await h.app.inject({
          method: "PATCH",
          url: "/api/movies/m",
          headers,
          payload: {
            title: "Local title",
            posterUrl: "http://169.254.169.254/latest/meta-data/",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await h.app.inject({ url: "/api/movies/m", headers })).json().title,
    ).toBe("Local title");
  } finally {
    await h.close();
  }
});
it("reassigns an edition without destroying the original watch history", async () => {
  const h = await createHarness();
  try {
    const s = issueSession(h.db, "owner"),
      headers = {
        cookie: `mov_session=${s.token}`,
        origin: "http://localhost:4310",
        "x-csrf-token": s.csrf,
      };
    h.db.exec(
      "INSERT INTO movies(id,title) VALUES('a','A'),('b','B'); INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES('source','a','gen','1'); INSERT INTO editions(id,movie_id,source_id,label,generation) VALUES('edition','a','source','Original','gen'); INSERT INTO progress VALUES('a','old',1,1,1200,0,0);",
    );
    const result = await h.app.inject({
      method: "PATCH",
      url: "/api/movies/b",
      headers,
      payload: { associateSourceId: "source" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().editions[0].id).toBe("edition");
    expect(
      (await h.app.inject({ url: "/api/movies/a", headers })).json().resumeMs,
    ).toBe(1200);
  } finally {
    await h.close();
  }
});
