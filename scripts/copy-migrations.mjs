import { cp, mkdir } from "node:fs/promises";
try {
  await mkdir("dist/packages/db/migrations", { recursive: true });
  await cp("packages/db/migrations", "dist/packages/db/migrations", {
    recursive: true,
  });
} catch {
  console.error("Migration packaging failed");
  process.exitCode = 1;
}
