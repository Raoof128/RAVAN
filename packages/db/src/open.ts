import Sqlite from "better-sqlite3";
import { chmodSync } from "node:fs";
import { migrate } from "./migrate.js";
export type Database = Sqlite.Database;
/**
 * Retry a startup step that lost a lock race to another process. The deadline
 * covers the retries, not a step already waiting inside SQLite's busy_timeout,
 * so the worst case is about twice this.
 */
function settle(step: () => unknown): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      step();
      return;
    } catch (error) {
      if (
        (error as { code?: string }).code !== "SQLITE_BUSY" ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(pause, 0, 0, 100);
    }
  }
}
export function openDatabase(path: string): Database {
  const db = new Sqlite(path);
  try {
    const { version } = db
      .prepare("SELECT sqlite_version() AS version")
      .get() as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    if (
      major < 3 ||
      (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))
    )
      throw new Error("SQLite 3.51.3 or newer required");
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    // On a brand-new file two processes can collide before WAL mode exists. SQLite
    // reports that lock upgrade as busy at once, without consulting busy_timeout.
    settle(() => db.pragma("journal_mode = WAL"));
    settle(() => migrate(db));
    // Restored snapshots can contain a factor replaced after the backup was taken.
    // Keep every application entrypoint closed until an offline operator resolves it.
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_quarantine'",
        )
        .get()
    )
      throw new Error("Restored database requires offline recovery review");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
