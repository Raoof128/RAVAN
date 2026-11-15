import type { AppConfig } from "../../apps/api/src/config.js";
import { afterEach } from "vitest";
import { createHarness } from "./harness.js";
import { PlaybackService } from "../../apps/api/src/sessions/playback.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
export async function sessionFixture(overrides: Partial<AppConfig> = {}) {
  const h = await createHarness(overrides);
  cleanup.push(h.close);
  h.db.prepare("INSERT INTO movies(id,title) VALUES('m','Film')").run();
  h.db
    .prepare(
      "INSERT INTO source_files(id,movie_id,generation,size_bytes,mime_type) VALUES('f','m','generation','10','video/mp4')",
    )
    .run();
  let now = 1000000;
  let access = true;
  const service = new PlaybackService(
    h.db,
    async () => {
      if (!access) throw new Error("removed");
      return { fileId: "f", generation: "generation", sizeBytes: "10" };
    },
    async () => ({ mode: "direct", assetId: "f" }),
    () => now,
  );
  return {
    ...h,
    service,
    advance: (ms: number) => {
      now += ms;
    },
    deny: () => {
      access = false;
    },
  };
}
