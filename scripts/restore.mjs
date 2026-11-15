import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { restoreEncryptedBackup } from "../dist/packages/db/src/backup.js";
try {
  const { values } = parseArgs({
    options: { source: { type: "string" }, target: { type: "string" } },
  });
  const key = process.env.MOV_BACKUP_KEY;
  if (!values.source || !values.target || !key || !/^[a-f0-9]{64}$/i.test(key))
    throw Error("Required restore configuration missing");
  await restoreEncryptedBackup(
    resolve(values.source),
    resolve(values.target),
    Buffer.from(key, "hex"),
  );
  console.log(
    "Backup verified and restored in quarantine. Offline security review and factor replacement are required before activation.",
  );
} catch {
  console.error(
    "Restore failed. Check backup key, integrity, schema version and empty target directory.",
  );
  process.exitCode = 1;
}
