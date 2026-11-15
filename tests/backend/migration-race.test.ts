import { expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { readdirSync } from "node:fs";
// One row per migration file, however many there are.
const migrationCount = readdirSync(
  new URL("../../packages/db/migrations/", import.meta.url),
).filter((name) => name.endsWith(".sql")).length;

// The API and the worker are separate processes that open the same database at
// startup. Each read the schema version and then applied what it thought was
// missing, so the loser of the race exited with "table ... already exists".
async function openTogether(path: string, processes = 4) {
  const module = new URL("../../packages/db/src/open.ts", import.meta.url).href;
  const at = Date.now() + 2500;
  const script = `
    const { openDatabase } = await import(${JSON.stringify(module)});
    while (Date.now() < ${at}) {}
    try { openDatabase(process.argv[1]).close(); }
    catch (error) { console.log(error.message); process.exit(3); }`;
  return Promise.all(
    Array.from(
      { length: processes },
      () =>
        new Promise<{ code: number | null; output: string }>((resolve) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script, path],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.on("close", (code) => resolve({ code, output }));
        }),
    ),
  );
}
function migrations(path: string) {
  const db = openDatabase(path);
  try {
    return db.prepare("SELECT count(*) AS n FROM schema_migrations").get();
  } finally {
    db.close();
  }
}
const started = Array(4).fill({ code: 0, output: "" });

it("lets several processes open a new database at the same moment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-migrate-"));
  try {
    const path = join(dir, "db.sqlite");
    expect(await openTogether(path)).toEqual(started);
    expect(migrations(path)).toEqual({ n: migrationCount });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("lets several processes apply a pending upgrade to an existing database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mov-migrate-"));
  try {
    const path = join(dir, "db.sqlite");
    // A deployed database one release behind: the first three migrations only.
    const db = new Sqlite(path);
    db.pragma("journal_mode = WAL");
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
    );
    for (const [index, file] of [
      "001_initial.sql",
      "002_ticket_overlap.sql",
      "003_mfa.sql",
    ].entries()) {
      db.exec(
        readFileSync(
          new URL(`../../packages/db/migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
      db.prepare("INSERT INTO schema_migrations VALUES (?,0)").run(index + 1);
    }
    db.prepare("INSERT INTO movies(id,title) VALUES('m','Kept')").run();
    db.close();
    expect(await openTogether(path)).toEqual(started);
    expect(migrations(path)).toEqual({ n: migrationCount });
    const upgraded = openDatabase(path);
    try {
      expect(upgraded.prepare("SELECT title FROM movies").get()).toEqual({
        title: "Kept",
      });
      expect(upgraded.prepare("SELECT * FROM prepared_assets").all()).toEqual(
        [],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
