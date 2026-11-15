import type { FastifyInstance } from "fastify";
import type { Database } from "../../../../packages/db/src/open.js";
import type { AppConfig } from "../config.js";
import {
  createDriveClient,
  driveId,
  type DriveClient,
} from "../drive/client.js";
import { LibrarySync } from "../drive/sync.js";
import { z } from "zod";
export function registerLibrary(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  injected?: DriveClient,
) {
  const token = app.getDecorator<() => Promise<string>>("getDriveAccessToken");
  const sync = new LibrarySync(db, injected ?? createDriveClient(token));
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  function run(folder: string, incremental = false) {
    if (pending) return;
    pending = sync
      .syncLibrary(folder, controller.signal, { incremental })
      .then(
        () => {
          failures = 0;
        },
        () => {
          failures = Math.min(failures + 1, 5);
        },
      )
      .finally(() => {
        pending = undefined;
      });
  }
  function schedule() {
    timer = setTimeout(
      () => {
        const status = sync.status();
        // Unattended refreshes ask Drive what changed; owner requests below scan fully.
        if (status.folderId) run(status.folderId, true);
        schedule();
      },
      60000 * 2 ** failures + Math.random() * 10000,
    );
    timer.unref();
  }
  if (config.mode !== "test") schedule();
  app.addHook("onClose", async () => {
    clearTimeout(timer);
    controller.abort();
    await pending;
  });
  app.get("/api/library", async () => sync.status());
  app.post("/api/library", async (request, reply) => {
    const body = z.strictObject({ folderId: driveId }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_folder" });
    if (pending && sync.status().folderId !== body.data.folderId)
      return reply.code(409).send({ error: "scan_in_progress" });
    // Changing folder: make sure the new one is real before the old one is replaced.
    if (sync.status().folderId !== body.data.folderId) {
      let usable: boolean;
      try {
        usable = await sync.checkFolder(
          body.data.folderId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
      } catch {
        return reply.code(503).send({ error: "drive_unavailable" });
      }
      if (!usable) return reply.code(400).send({ error: "invalid_folder" });
      // A scheduled scan of the old folder may have started while Drive
      // answered. Do not report a scan that would not run.
      if (pending) return reply.code(409).send({ error: "scan_in_progress" });
    }
    run(body.data.folderId);
    return reply.code(202).send({ scanId: "library" });
  });
  app.post("/api/library/sync", async (_request, reply) => {
    const status = sync.status();
    if (!status.folderId)
      return reply.code(409).send({ error: "choose_folder" });
    run(status.folderId);
    return reply.code(202).send({ scanId: "library" });
  });
  return sync;
}
