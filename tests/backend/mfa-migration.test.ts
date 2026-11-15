import { expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { migrate } from "../../packages/db/src/migrate.js";

it("upgrading a populated pre-MFA database invalidates old browser, TV, pairing and playback credentials", () => {
  const db = new Sqlite(":memory:");
  try {
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
    );
    for (const [index, file] of [
      "001_initial.sql",
      "002_ticket_overlap.sql",
    ].entries()) {
      db.exec(
        readFileSync(
          new URL(`../../packages/db/migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
      db.prepare("INSERT INTO schema_migrations VALUES (?,0)").run(index + 1);
    }
    db.exec(`
      INSERT INTO web_sessions VALUES ('legacy','owner','csrf',9999999999999);
      INSERT INTO devices(id,name,token_hash) VALUES ('tv','LG C1','token');
      INSERT INTO movies(id,title) VALUES ('movie','Private film');
      INSERT INTO source_files(id,movie_id,generation,size_bytes) VALUES ('source','movie','g','10');
      INSERT INTO playback_sessions(id,ticket_hash,movie_id,source_id,generation,web_session_hash,epoch,lease_until,access_until,expires_at) VALUES ('stream','ticket','movie','source','g','legacy',1,9999999999999,9999999999999,9999999999999);
      INSERT INTO pairing_requests(id,code_hash,poll_hash,expires_at) VALUES ('pair','code','poll',9999999999999);
    `);
    migrate(db);
    expect(db.prepare("SELECT * FROM web_sessions").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM pairing_requests").all()).toHaveLength(0);
    expect(
      db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL").all(),
    ).toHaveLength(0);
    expect(
      db
        .prepare("SELECT * FROM playback_sessions WHERE revoked_at IS NULL")
        .all(),
    ).toHaveLength(0);
    expect(db.prepare("SELECT title FROM movies").get()).toEqual({
      title: "Private film",
    });
    migrate(db); // Reopening must not revoke future MFA sessions a second time.
    expect(
      db.prepare("SELECT count(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 4 });
  } finally {
    db.close();
  }
});
