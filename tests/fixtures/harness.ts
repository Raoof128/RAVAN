import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { parseConfig, type AppConfig } from "../../apps/api/src/config.js";
import type { Database } from "../../packages/db/src/open.js";
export async function createHarness(overrides: Partial<AppConfig> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "mov-test-"));
  try {
    const app = await buildApp(
      parseConfig({ mode: "test", dataDir, minFreeBytes: 0, ...overrides }),
    );
    return {
      app,
      db: app.getDecorator<Database>("database"),
      async close() {
        await app.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
