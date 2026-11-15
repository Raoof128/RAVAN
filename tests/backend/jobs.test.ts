import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/db/src/open.js";
import { JobQueue } from "../../apps/worker/src/leases.js";
import { runProcess } from "../../apps/worker/src/process.js";
import { probeMedia } from "../../apps/worker/src/probe.js";
import { prepareMedia } from "../../apps/worker/src/prepare.js";
import { validateOutput } from "../../apps/worker/src/output-validation.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), "mov-jobs-"));
  cleanup.push(() => rm(d, { recursive: true, force: true }));
  return d;
}
it("coalesces jobs and recovers an expired claim", async () => {
  const db = openDatabase(join(await directory(), "db.sqlite"));
  cleanup.push(async () => {
    db.close();
  });
  let now = 100;
  const jobs = new JobQueue(db, () => now);
  const id = jobs.enqueue("probe", "same", { fileId: "one" });
  expect(jobs.enqueue("probe", "same", { fileId: "one" })).toBe(id);
  const first = jobs.claim();
  expect(first?.id).toBe(id);
  expect(jobs.claim()).toBeUndefined();
  now += 70000;
  expect(jobs.claim()?.id).toBe(id);
});
it("probes and prepares an actual synthetic file and publishes only complete VOD", async () => {
  const d = await directory(),
    input = join(d, "input.mp4");
  await runProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      input,
    ],
    new AbortController().signal,
    10000,
  );
  const probe = await probeMedia(input, new AbortController().signal);
  expect(probe.video?.codec).toBe("h264");
  const output = join(d, "prepared");
  await prepareMedia(
    {
      input,
      output,
      probe,
      sourceBytes: 10000n,
      inputBudget: 20000n,
      outputBoundaryVerified: true,
    },
    new AbortController().signal,
  );
  await validateOutput(output);
  expect(await readFile(join(output, "index.m3u8"), "utf8")).toContain(
    "#EXT-X-ENDLIST",
  );
});
it("rejects truncated input, oversized staging, absent output boundary, unsafe manifests and cancelled output", async () => {
  const d = await directory(),
    input = join(d, "broken.mp4");
  await writeFile(input, "broken");
  await expect(
    probeMedia(input, new AbortController().signal),
  ).rejects.toThrow();
  const options = {
    input,
    output: join(d, "out"),
    probe: {
      durationMs: 1,
      container: "mp4",
      video: {
        codec: "h264",
        pixelFormat: "yuv420p",
        width: 160,
        height: 90,
        hdr: false,
      },
      audio: [],
      subtitles: [],
    },
    sourceBytes: 100n,
    inputBudget: 10n,
    outputBoundaryVerified: true,
  };
  await expect(
    prepareMedia(options, new AbortController().signal),
  ).rejects.toThrow(/budget/);
  await expect(
    prepareMedia(
      { ...options, inputBudget: 1000n, outputBoundaryVerified: false },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/boundary/);
  await writeFile(
    join(d, "index.m3u8"),
    "#EXTM3U\n#EXTINF:6,\n../secret.ts\n#EXT-X-ENDLIST\n",
  );
  await expect(validateOutput(d)).rejects.toThrow();
  const c = new AbortController();
  c.abort();
  await expect(
    prepareMedia({ ...options, inputBudget: 1000n }, c.signal),
  ).rejects.toThrow();
  await expect(access(options.output)).rejects.toThrow();
});
it("classifies resource failures without exposing stderr secrets and persists the safe code", async () => {
  const { mediaFailureCode } = await import("../../apps/worker/src/process.js");
  let error: unknown;
  try {
    await runProcess(
      process.execPath,
      [
        "-e",
        "process.stderr.write('Authorization: Bearer private-test-key https://private.invalid/source pthread_create() failed: Resource temporarily unavailable');process.exit(1)",
      ],
      new AbortController().signal,
    );
  } catch (e) {
    error = e;
  }
  expect(mediaFailureCode(error)).toBe("media_resources");
  expect(JSON.stringify(error)).not.toMatch(
    /private-test-key|private.invalid|Authorization/,
  );
  const db = openDatabase(join(await directory(), "db.sqlite"));
  cleanup.push(async () => {
    db.close();
  });
  const queue = new JobQueue(db);
  queue.enqueue("browser-prepare", "resource", {});
  const job = queue.claim()!;
  queue.fail(job, mediaFailureCode(error));
  expect(db.prepare("SELECT error_code,state FROM jobs").get()).toEqual({
    error_code: "media_resources",
    state: "queued",
  });
});
it.each([
  ["No space left on device", "media_storage"],
  ["HTTP error 503 Service Unavailable", "media_source"],
  ["Invalid data found when processing input", "media_failed"],
])("classifies %s using only a fixed code", async (message, code) => {
  const { mediaFailureCode } = await import("../../apps/worker/src/process.js");
  try {
    await runProcess(
      process.execPath,
      [
        "-e",
        `process.stderr.write(${JSON.stringify(message)});process.exit(1)`,
      ],
      new AbortController().signal,
    );
    throw Error("Expected failure");
  } catch (error) {
    expect(mediaFailureCode(error)).toBe(code);
  }
});
