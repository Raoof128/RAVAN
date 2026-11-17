import { expect, it } from "vitest";
import { openArchive } from "../../apps/web/src/reading/archive.js";
import { readingZip } from "../fixtures/reading.js";
it("checks real decompressed bytes even when an archive lies about its size", async () => {
  const buffer = await readingZip({ "chapter.txt": "A".repeat(10000) });
  // Lie in the central directory; the local record and actual stream remain larger.
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(10, central + 24);
  const archive = await openArchive(
    new Blob([new Uint8Array(buffer)]),
    new AbortController().signal,
  );
  try {
    await expect(archive.read("chapter.txt", 100)).rejects.toThrow();
  } finally {
    await archive.close();
  }
});
it("rejects traversal and oversized entries before extraction and honors cancellation", async () => {
  const traversal = await readingZip({ "../escape.txt": "no" });
  await expect(
    openArchive(
      new Blob([new Uint8Array(traversal)]),
      new AbortController().signal,
    ),
  ).rejects.toThrow(/unsafe file/i);
  const buffer = await readingZip({ "page.png": "tiny" });
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(33 * 1024 * 1024, central + 24);
  await expect(
    openArchive(
      new Blob([new Uint8Array(buffer)]),
      new AbortController().signal,
    ),
  ).rejects.toThrow("extraction limits");
  const controller = new AbortController();
  controller.abort();
  await expect(
    openArchive(
      new Blob([new Uint8Array(await readingZip({ "page.png": "tiny" }))]),
      controller.signal,
    ),
  ).rejects.toThrow();
});
