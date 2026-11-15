import { expect, it } from "vitest";
import { createHarness } from "../fixtures/harness.js";

// The router percent-decodes a path before matching it, so a guard that inspects
// the raw request URL can be skipped while the private handler still runs.
const encodedPrefixes = ["/%61pi", "/a%70i", "/%61%70%69", "/ap%69"];

it("requires authentication for private handlers reached through an encoded path", async () => {
  const h = await createHarness({ encryptionKey: "ab".repeat(32) });
  try {
    h.db
      .prepare("INSERT INTO movies(id,title) VALUES('m','Private film')")
      .run();
    h.db
      .prepare(
        "INSERT INTO devices(id,name,token_hash) VALUES('tv','TV','hash')",
      )
      .run();
    const requests: Array<
      ["GET" | "PUT" | "PATCH" | "POST" | "DELETE", string, object?]
    > = [
      ["GET", "/movies"],
      ["GET", "/movies/m"],
      ["GET", "/devices"],
      ["GET", "/library"],
      ["GET", "/preferences"],
      ["PUT", "/preferences", { audioLanguage: "fa" }],
      ["PATCH", "/movies/m", { title: "Defaced" }],
      ["PUT", "/watchlist/m", { saved: true }],
      ["POST", "/library", { folderId: "attacker-folder" }],
      ["POST", "/library/sync", {}],
      ["DELETE", "/devices/tv"],
      ["POST", "/pairing/approve", { code: "ABCDEFGH" }],
      ["POST", "/logout", {}],
    ];
    for (const prefix of encodedPrefixes)
      for (const [method, path, payload] of requests) {
        const response = await h.app.inject({
          method,
          url: prefix + path,
          ...(payload ? { payload } : {}),
        });
        expect(response.statusCode, `${method} ${prefix}${path}`).toBe(401);
        expect(response.body).not.toContain("Private film");
      }
    expect(h.db.prepare("SELECT title FROM movies").get()).toEqual({
      title: "Private film",
    });
    expect(
      h.db.prepare("SELECT revoked_at FROM devices WHERE id='tv'").get(),
    ).toEqual({ revoked_at: null });
    expect(h.db.prepare("SELECT * FROM sync_checkpoints").all()).toEqual([]);
    expect(h.db.prepare("SELECT * FROM watchlist").all()).toEqual([]);
    expect(h.db.prepare("SELECT * FROM preferences").all()).toEqual([]);
  } finally {
    await h.close();
  }
});

it("cannot self-approve an anonymous pairing request into a device credential", async () => {
  const h = await createHarness({ encryptionKey: "ab".repeat(32) });
  try {
    const pairing = (
      await h.app.inject({
        method: "POST",
        url: "/api/pairing",
        payload: { name: "Attacker" },
      })
    ).json();
    expect(pairing.code).toHaveLength(8);
    const approval = await h.app.inject({
      method: "POST",
      url: "/%61pi/pairing/approve",
      payload: { code: pairing.code },
    });
    expect(approval.statusCode).toBe(401);
    expect(h.db.prepare("SELECT * FROM devices").all()).toEqual([]);
  } finally {
    await h.close();
  }
});

it("keeps the public session and pairing entry points reachable in either spelling", async () => {
  const h = await createHarness();
  try {
    for (const url of ["/api/session", "/%61pi/session"])
      expect((await h.app.inject(url)).json()).toEqual({
        authenticated: false,
        configured: false,
      });
    expect((await h.app.inject("/api/unknown")).statusCode).toBe(401);
    expect((await h.app.inject("/%61pi/unknown")).statusCode).toBe(401);
  } finally {
    await h.close();
  }
});
