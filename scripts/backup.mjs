import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import Sqlite from "better-sqlite3";
import { createEncryptedBackup } from "../dist/packages/db/src/backup.js";
let db;
try {
  const { values } = parseArgs({
    options: { destination: { type: "string" } },
  });
  const key = process.env.MOV_BACKUP_KEY;
  if (
    !values.destination ||
    !process.env.MOV_DATA_DIR ||
    !key ||
    !/^[a-f0-9]{64}$/i.test(key)
  )
    throw Error("Required backup configuration missing");
  db = new Sqlite(join(process.env.MOV_DATA_DIR, "mov.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  await createEncryptedBackup(
    db,
    resolve(values.destination),
    Buffer.from(key, "hex"),
  );
  console.log("Encrypted consistent backup created.");
} catch {
  console.error(
    "Backup failed. Check key, source database and destination; existing backups are never overwritten.",
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
