import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig } from "../../apps/api/src/config.js";
import { openDatabase } from "../../packages/db/src/open.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function folder() {
  const path = await mkdtemp(join(tmpdir(), "mov-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
describe("backend foundation", () => {
  it("boots_without_secrets_exposed", async () => {
    const dataDir = await folder();
    const app = await buildApp(parseConfig({ dataDir, minFreeBytes: 0 }));
    cleanups.push(() => app.close());
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    expect((await app.inject("/api/movies")).statusCode).toBe(401);
    expect((await app.inject("/api/session")).json()).toEqual({
      authenticated: false,
      configured: false,
    });
  });
  it("persists_after_reopen", async () => {
    const path = join(await folder(), "test.sqlite");
    let db = openDatabase(path);
    db.prepare("INSERT INTO movies(id,title) VALUES (?,?)").run("m1", "A film");
    db.close();
    db = openDatabase(path);
    expect(db.prepare("SELECT title FROM movies WHERE id=?").get("m1")).toEqual(
      { title: "A film" },
    );
    expect(
      db.prepare("SELECT count(*) AS n FROM schema_migrations").get(),
    ).toEqual({ n: 4 });
    db.close();
  });
  it("enables_foreign_keys", async () => {
    const db = openDatabase(join(await folder(), "test.sqlite"));
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES (?,?,?,?)",
        )
        .run("s", "absent", "v1", "10"),
    ).toThrow();
    db.close();
  });
  it("rejects_invalid_config", () => {
    expect(() => parseConfig({ port: 0 })).toThrow();
    expect(() =>
      parseConfig({ mode: "production", minFreeBytes: 0 }),
    ).toThrow();
    expect(() =>
      parseConfig({ mode: "production", host: "0.0.0.0" }),
    ).toThrow();
  });
  it("fails readiness when disk reserve cannot be met", async () => {
    const app = await buildApp(
      parseConfig({
        dataDir: await folder(),
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
    );
    cleanups.push(() => app.close());
    expect((await app.inject("/readyz")).statusCode).toBe(503);
  });
  it("fails startup if database directory is invalid", async () => {
    await expect(
      buildApp(parseConfig({ dataDir: "/dev/null/mov", minFreeBytes: 0 })),
    ).rejects.toThrow();
  });
});
