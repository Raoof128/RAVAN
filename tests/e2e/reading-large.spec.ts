import { test, expect } from "@playwright/test";
import type { ReadingItem } from "../../packages/contracts/src/reading.js";
import { virtualPdf } from "../fixtures/reading.js";

// Production, 22 November 2026: 30 of 42 Berserk volumes are 100 to 347 MB.
// A PDF opens in pieces, so it may be up to 512 MB; an EPUB, held whole,
// stays at 100 MB.
test("opens a 150 MB PDF in pieces and says plainly when an EPUB is too large", async ({
  page,
}) => {
  const MB = 1024 * 1024;
  const size = 150 * MB;
  const bytesAt = virtualPdf(size);
  const item = (
    id: string,
    title: string,
    format: ReadingItem["format"],
  ): ReadingItem => ({
    id,
    title,
    name: `${title}.${format}`,
    format,
    generation: "a".repeat(64),
    sizeBytes: String(size),
    position: { section: 0, fraction: 0 },
    preparation: { state: "on-demand", percent: 0 },
  });
  const books = [
    item("vol2", "Berserk - Volume 02", "pdf"),
    item("novel", "A long novel", "epub"),
  ];
  let served = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: { authenticated: true, configured: true, csrfToken: "t" },
      });
    if (url.pathname === "/api/reading")
      return route.fulfill({ json: { items: books, nextOffset: null } });
    if (url.pathname === "/api/reading/vol2/preparation")
      return route.fulfill({ json: { state: "on-demand", percent: 0 } });
    if (url.pathname === "/api/reading/vol2/content") {
      const slices = url.searchParams.get("slices");
      if (slices) {
        const body = Buffer.concat(
          slices
            .split(",")
            .map((s) =>
              Buffer.from(
                bytesAt(
                  Number(s) * 16384,
                  Math.min(size, (Number(s) + 1) * 16384),
                ),
              ),
            ),
        );
        served += body.length;
        return route.fulfill({
          contentType: "application/octet-stream",
          body,
        });
      }
      const [start, end] = route
        .request()
        .headers()
        .range!.slice(6)
        .split("-")
        .map(Number);
      served += end! - start! + 1;
      return route.fulfill({
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${start}-${end}/${size}`,
        },
        body: Buffer.from(bytesAt(start!, end! + 1)),
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/#/reading");
  await expect(page.getByText("PDF up to 512 MB")).toBeVisible();

  await page.getByRole("button", { name: /A long novel/ }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "EPUB and comic books open up to 100 MB. This one is larger.",
  );

  await page.getByRole("button", { name: /Berserk - Volume 02/ }).click();
  await expect(page.locator(".reading-pdf canvas")).toBeVisible({
    timeout: 20000,
  });
  // The first page came from the ends of the book, not all 150 MB.
  expect(served).toBeLessThan(8 * MB);
});
