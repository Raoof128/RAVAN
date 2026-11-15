import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import Sqlite from "better-sqlite3";
import type { Database } from "./open.js";
import { migrate } from "./migrate.js";

const MAGIC = Buffer.from("RAVANBK1");
const MAX_BYTES = 64 * 1024 ** 2;
function backupKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("A 32-byte backup key is required");
  return Buffer.from(hkdfSync("sha256", key, MAGIC, "ravan:backup:v1", 32));
}
async function boundedRead(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES + 36)
      throw new Error("Backup exceeds the 64 MiB metadata limit");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Incomplete backup");
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
async function privateWrite(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Use SQLite's online backup API so committed WAL transactions are included. */
export async function createEncryptedBackup(
  db: Database,
  destination: string,
  key: Buffer,
): Promise<void> {
  const derived = backupKey(key);
  const work = await mkdtemp(join(dirname(destination), ".ravan-backup-"));
  try {
    await chmod(work, 0o700);
    const snapshot = join(work, "snapshot.sqlite");
    await db.backup(snapshot);
    await chmod(snapshot, 0o600);
    const plain = await boundedRead(snapshot);
    if (plain.length > MAX_BYTES)
      throw new Error("Database exceeds the 64 MiB metadata limit");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    plain.fill(0);
    const staged = join(work, "encrypted");
    await privateWrite(
      staged,
      Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]),
    );
    // An exclusive hard link publishes a complete artifact without replacing an older backup.
    await link(staged, destination);
  } finally {
    derived.fill(0);
    await rm(work, { recursive: true, force: true });
  }
}

/** Restore offline into an empty directory. Never pass the live data directory. */
export async function restoreEncryptedBackup(
  source: string,
  directory: string,
  key: Buffer,
): Promise<string> {
  const derived = backupKey(key);
  let plain: Buffer;
  try {
    const bytes = await boundedRead(source);
    if (bytes.length < 37 || !bytes.subarray(0, 8).equals(MAGIC))
      throw new Error("Invalid backup format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derived,
      bytes.subarray(8, 20),
    );
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(bytes.subarray(20, 36));
    plain = Buffer.concat([
      decipher.update(bytes.subarray(36)),
      decipher.final(),
    ]);
  } finally {
    derived.fill(0);
  }
  try {
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await readdir(directory)).length
    )
      throw new Error("Restore target must be an empty real directory");
    await chmod(directory, 0o700);
    const work = await mkdtemp(join(directory, ".restore-"));
    try {
      const candidate = join(work, "mov.sqlite");
      await privateWrite(candidate, plain);
      const db = new Sqlite(candidate);
      try {
        if (db.pragma("quick_check", { simple: true }) !== "ok")
          throw new Error("Backup database integrity check failed");
        try {
          migrate(db);
        } catch {
          throw new Error("Backup schema is incompatible with this release");
        }
        // Historical snapshots must not revive sessions or devices revoked since backup.
        db.transaction(() => {
          db.exec(
            "CREATE TABLE IF NOT EXISTS restore_quarantine(reason TEXT NOT NULL); DELETE FROM restore_quarantine; INSERT INTO restore_quarantine VALUES ('Offline review and factor replacement required'); DELETE FROM mfa_recovery;",
          );
          db.prepare(
            "UPDATE owner_mfa SET last_counter=max(last_counter,?)",
          ).run(Math.floor(Date.now() / 30000));
          db.exec(
            "DELETE FROM web_sessions; DELETE FROM mfa_challenges; DELETE FROM pairing_requests; DELETE FROM prepared_assets; DELETE FROM jobs WHERE kind IN ('browser-prepare','artwork'); DELETE FROM artwork;",
          );
          // The pictures are not in the backup: let them be made, and looked up, again.
          if (
            db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artwork_lookups'",
              )
              .get()
          )
            db.exec("DELETE FROM artwork_lookups;");
          db.prepare(
            "UPDATE devices SET revoked_at=? WHERE revoked_at IS NULL",
          ).run(Date.now());
          db.prepare(
            "UPDATE playback_sessions SET revoked_at=? WHERE revoked_at IS NULL",
          ).run(Date.now());
        })();
      } finally {
        db.close();
      }
      const target = join(directory, "mov.sqlite");
      await link(candidate, target);
      return target;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } finally {
    plain.fill(0);
  }
}
