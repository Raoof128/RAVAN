import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig, startupReason } from "../../apps/api/src/config.js";
import { openDatabase } from "../../packages/db/src/open.js";
import { readdirSync } from "node:fs";
// One row per migration file, however many there are.
const migrationCount = readdirSync(
  new URL("../../packages/db/migrations/", import.meta.url),
).filter((name) => name.endsWith(".sql")).length;

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
    ).toEqual({ n: migrationCount });
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
  it("rejects an origin that could never match a browser Origin header", () => {
    for (const origin of [
      "https://ravan.example/",
      "https://ravan.example/app",
      "https://ravan.example?x=1",
    ])
      expect(() => parseConfig({ origin })).toThrow();
    expect(parseConfig({ origin: "https://ravan.example:8443" }).origin).toBe(
      "https://ravan.example:8443",
    );
  });
  it("explains a failed start without printing configuration values", () => {
    let failure: unknown;
    try {
      parseConfig({
        mode: "production",
        origin: "https://ravan.example",
        clientId: "client",
        clientSecret: "super-secret-value",
        ownerSubject: "owner",
        encryptionKey: "not-hex-private-key-material",
      });
    } catch (error) {
      failure = error;
    }
    const reason = startupReason(failure);
    expect(reason).toContain("encryptionKey");
    expect(reason).not.toMatch(
      /super-secret-value|not-hex-private-key-material/,
    );
    expect(startupReason(new Error("Restored database requires review"))).toBe(
      "Restored database requires review",
    );
    expect(
      startupReason(Object.assign(new Error("open /x"), { code: "EACCES" })),
    ).toBe("EACCES");
  });
  it("uses one error shape for unknown routes and rate limits", async () => {
    const app = await buildApp(
      parseConfig({ dataDir: await folder(), minFreeBytes: 0 }),
    );
    cleanups.push(() => app.close());
    const missing = await app.inject("/no/such/<path>");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
    let limited = await app.inject("/healthz");
    for (let i = 0; i < 125 && limited.statusCode !== 429; i++)
      limited = await app.inject("/healthz");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers["retry-after"]).toBeTruthy();
  });
  it("refuses a prepared volume too small to hold an edition beside its neighbours", () => {
    for (const bytes of [1024 ** 3, 4 * 1024 ** 3, "tiny"])
      expect(() => parseConfig({ preparedCapacityBytes: bytes })).toThrow();
    expect(
      parseConfig({ preparedCapacityBytes: String(60 * 1024 ** 3) })
        .preparedCapacityBytes,
    ).toBe(60 * 1024 ** 3);
    expect(parseConfig({}).preparedCapacityBytes).toBe(20 * 1024 ** 3);
    expect(parseConfig({}).preparedFormat).toBe("hls");
    expect(() => parseConfig({ preparedFormat: "dash" })).toThrow();
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
