import Sqlite from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../packages/db/src/open.js";
import {
  createEncryptedBackup,
  restoreEncryptedBackup,
} from "../../packages/db/src/backup.js";
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ravan-backup-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "live.sqlite"));
  clean.push(async () => db.close());
  const key = Buffer.alloc(32, 19);
  db.prepare(
    "INSERT INTO movies(id,title) VALUES ('m','PRIVATE TEST FILM')",
  ).run();
  db.prepare(
    "INSERT INTO devices(id,name,token_hash,revoked_at) VALUES ('tv','TV','hashed',123)",
  ).run();
  return { dir, db, key };
}
it("encrypts a consistent WAL snapshot and restores metadata plus revoked-device state", async () => {
  const f = await setup(),
    path = join(f.dir, "backup.ravan");
  await createEncryptedBackup(f.db, path, f.key);
  expect(
    (await readFile(path)).includes(Buffer.from("PRIVATE TEST FILM")),
  ).toBe(false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const restored = await restoreEncryptedBackup(
    path,
    join(f.dir, "restored"),
    f.key,
  );
  const db = new Sqlite(restored, { readonly: true });
  try {
    expect(db.prepare("SELECT id FROM server_identity").get()).not.toEqual(
      f.db.prepare("SELECT id FROM server_identity").get(),
    );
    expect(db.prepare("SELECT title FROM movies").get()).toEqual({
      title: "PRIVATE TEST FILM",
    });
    expect(db.prepare("SELECT revoked_at FROM devices").get()).toEqual({
      revoked_at: 123,
    });
  } finally {
    db.close();
  }
});
it("refuses missing/wrong keys, corrupt backup and overwrite of existing data", async () => {
  const f = await setup(),
    path = join(f.dir, "backup.ravan");
  await expect(
    createEncryptedBackup(f.db, path, Buffer.alloc(0)),
  ).rejects.toThrow();
  await createEncryptedBackup(f.db, path, f.key);
  await expect(createEncryptedBackup(f.db, path, f.key)).rejects.toThrow();
  await expect(
    restoreEncryptedBackup(path, join(f.dir, "wrong"), Buffer.alloc(32)),
  ).rejects.toThrow();
  const existing = join(f.dir, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep"), "preserve");
  await expect(restoreEncryptedBackup(path, existing, f.key)).rejects.toThrow();
  expect(await readFile(join(existing, "keep"), "utf8")).toBe("preserve");
  const bytes = await readFile(path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(join(f.dir, "corrupt.ravan"), bytes);
  await expect(
    restoreEncryptedBackup(
      join(f.dir, "corrupt.ravan"),
      join(f.dir, "bad"),
      f.key,
    ),
  ).rejects.toThrow();
});
it("refuses restoration of a schema newer than this release", async () => {
  const f = await setup();
  f.db.prepare("INSERT INTO schema_migrations VALUES(999,0)").run();
  const path = join(f.dir, "future.ravan");
  await createEncryptedBackup(f.db, path, f.key);
  await expect(
    restoreEncryptedBackup(path, join(f.dir, "future"), f.key),
  ).rejects.toThrow(/schema/i);
});

it("never publishes an interrupted snapshot or restores active authorizations", async () => {
  const f = await setup();
  f.db
    .prepare(
      "INSERT INTO web_sessions VALUES ('active','owner','csrf',9999999999999)",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO devices(id,name,token_hash,reading) VALUES ('active-tv','TV','newhash',1)",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO device_reader_sessions VALUES ('cookie-hash','active-tv','reader-csrf',9999999999999)",
    )
    .run();
  const path = join(f.dir, "active.ravan");
  await createEncryptedBackup(f.db, path, f.key);
  const restored = await restoreEncryptedBackup(
    path,
    join(f.dir, "offline"),
    f.key,
  );
  const db = new Sqlite(restored, { readonly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM web_sessions").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT * FROM device_reader_sessions").all()).toEqual(
      [],
    );
    expect(
      db
        .prepare("SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
  const closed = openDatabase(join(f.dir, "closed.sqlite"));
  closed.close();
  await expect(
    createEncryptedBackup(closed, join(f.dir, "interrupted.ravan"), f.key),
  ).rejects.toThrow();
  await expect(stat(join(f.dir, "interrupted.ravan"))).rejects.toThrow();
});

it("quarantines restored factors and removes historical recovery codes", async () => {
  const f = await setup();
  f.db
    .prepare("INSERT INTO owner_mfa VALUES ('owner','encrypted-seed',0,0)")
    .run();
  f.db.prepare("INSERT INTO mfa_recovery VALUES ('owner','old-code')").run();
  const path = join(f.dir, "factor.ravan");
  await createEncryptedBackup(f.db, path, f.key);
  const restored = await restoreEncryptedBackup(
    path,
    join(f.dir, "quarantine"),
    f.key,
  );
  expect(() => openDatabase(restored)).toThrow(/offline recovery review/i);
  const db = new Sqlite(restored, { readonly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM mfa_recovery").get()).toEqual({
      n: 0,
    });
    expect(
      (
        db.prepare("SELECT last_counter AS n FROM owner_mfa").get() as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
it("restores without stale prepared assets or completed conversion jobs", async () => {
  const f = await setup(),
    path = join(f.dir, "prepared.ravan");
  f.db
    .prepare(
      "INSERT INTO prepared_assets(id,source_id,generation,quality,audio_track,state,last_used) VALUES('asset','source','generation','auto',0,'ready',0)",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO jobs(id,unique_key,kind,payload,state) VALUES('job','browser:asset','browser-prepare','{}','completed')",
    )
    .run();
  await createEncryptedBackup(f.db, path, f.key);
  const restored = await restoreEncryptedBackup(
    path,
    join(f.dir, "prepared-restored"),
    f.key,
  );
  const db = new Sqlite(restored, { readonly: true });
  try {
    expect(db.prepare("SELECT * FROM prepared_assets").all()).toHaveLength(0);
    expect(
      db.prepare("SELECT * FROM jobs WHERE kind='browser-prepare'").all(),
    ).toHaveLength(0);
    expect(db.prepare("SELECT * FROM restore_quarantine").all()).toHaveLength(
      1,
    );
  } finally {
    db.close();
  }
});
