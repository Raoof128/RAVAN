import { readFileSync } from "node:fs";
import type { Database } from "./open.js";
export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const version =
    (
      db
        .prepare("SELECT max(version) AS version FROM schema_migrations")
        .get() as { version: number | null }
    ).version ?? 0;
  const files = [
    "001_initial.sql",
    "002_ticket_overlap.sql",
    "003_mfa.sql",
    "004_prepared.sql",
  ];
  if (version > files.length)
    throw new Error("Database version newer than this application");
  for (let next = version + 1; next <= files.length; next++) {
    // Both source and built output carry the same immutable SQL migration.
    const sql = readFileSync(
      new URL(`../migrations/${files[next - 1]}`, import.meta.url),
      "utf8",
    );
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(
        next,
        Date.now(),
      );
    })();
  }
}
