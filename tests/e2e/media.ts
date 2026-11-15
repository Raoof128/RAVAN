import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
export async function serveSyntheticMedia(page: Page) {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  await page.route("**/media/s/test/raw", async (route) => {
    const value = route.request().headers().range;
    const match = value && /^bytes=(\d+)-(\d*)$/.exec(value);
    if (match) {
      const start = Number(match[1]),
        end = match[2]
          ? Math.min(Number(match[2]), bytes.length - 1)
          : bytes.length - 1;
      if (start > end) {
        await route.fulfill({
          status: 416,
          headers: { "content-range": `bytes */${bytes.length}` },
        });
        return;
      }
      await route.fulfill({
        status: 206,
        contentType: "video/mp4",
        body: bytes.subarray(start, end + 1),
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "video/mp4",
      body: bytes,
      headers: { "accept-ranges": "bytes" },
    });
  });
}
