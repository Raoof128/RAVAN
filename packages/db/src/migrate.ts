import { readFileSync } from "node:fs";
import type { Database } from "./open.js";
const files = [
  "001_initial.sql",
  "002_ticket_overlap.sql",
  "003_mfa.sql",
  "004_prepared.sql",
  "005_job_priority.sql",
  "006_streaming.sql",
  "007_artwork.sql",
  "008_folders.sql",
  "009_reading.sql",
  "010_reading_cache.sql",
  "011_reading_covers.sql",
  "012_title_follows_drive.sql",
  "013_apple.sql",
];
function current(db: Database): number {
  return (
    (
      db
        .prepare("SELECT max(version) AS version FROM schema_migrations")
        .get() as { version: number | null }
    ).version ?? 0
  );
}
export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  if (current(db) > files.length)
    throw new Error("Database version newer than this application");
  if (current(db) === files.length) return;
  // The API and the worker open the same file at startup. Take the write lock
  // before deciding what to apply: reading the version first let both try the
  // same migration, and the loser crashed on "table already exists".
  db.transaction(() => {
    for (let next = current(db) + 1; next <= files.length; next++) {
      // Both source and built output carry the same immutable SQL migration.
      const sql = readFileSync(
        new URL(`../migrations/${files[next - 1]}`, import.meta.url),
        "utf8",
      );
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(
        next,
        Date.now(),
      );
    }
  }).immediate();
}
