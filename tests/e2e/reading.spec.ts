import { test, expect, type Page } from "@playwright/test";
import type {
  ReadingItem,
  ReadingPosition,
} from "../../packages/contracts/src/reading.js";
import { epubFixture, pdfFixture, readingZip } from "../fixtures/reading.js";

/** Exercise every format through the authenticated Drive catalogue and byte route. */
async function driveShelf(
  page: Page,
  books: Array<{
    id: string;
    title: string;
    format: ReadingItem["format"];
    buffer: Buffer;
  }>,
) {
  const items: ReadingItem[] = books.map((book) => ({
    id: book.id,
    title: book.title,
    name: `${book.title}.${book.format}`,
    format: book.format,
    generation: "a".repeat(64),
    sizeBytes: String(book.buffer.length),
    position: { section: 0, fraction: 0 },
    preparation: { state: "on-demand", percent: 0 },
  }));
  const saves: Array<ReadingPosition & { generation: string }> = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: { authenticated: true, configured: true, csrfToken: "test" },
      });
    if (url.pathname === "/api/reading") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      return route.fulfill({
        json: {
          items: items.filter((item) =>
            item.title.toLowerCase().includes(query),
          ),
          nextOffset: null,
        },
      });
    }
    const match =
      /^\/api\/reading\/([^/]+)\/(content|progress|preparation)$/.exec(
        url.pathname,
      );
    if (match) {
      const book = books.find((book) => book.id === match[1]);
      const item = items.find((item) => item.id === match[1]);
      if (!book || !item) return route.fulfill({ status: 404 });
      if (match[2] === "preparation") {
        if (route.request().method() === "POST")
          item.preparation = { state: "preparing", percent: 25 };
        return route.fulfill({ json: item.preparation });
      }
      if (match[2] === "content") {
        expect(url.searchParams.get("generation")).toBe(item.generation);
        const slices = url.searchParams.get("slices");
        if (slices)
          return route.fulfill({
            contentType: "application/octet-stream",
            body: Buffer.concat(
              slices
                .split(",")
                .map((s) =>
                  book.buffer.subarray(
                    Number(s) * 16384,
                    (Number(s) + 1) * 16384,
                  ),
                ),
            ),
          });
        const range = route.request().headers().range;
        expect(range).toMatch(/^bytes=\d+-\d+$/);
        const [start, end] = range!.slice(6).split("-").map(Number);
        return route.fulfill({
          status: 206,
          headers: {
            "content-type": "application/octet-stream",
            "content-range": `bytes ${start}-${end}/${book.buffer.length}`,
          },
          body: book.buffer.subarray(start, end! + 1),
        });
      }
      const position = route.request().postDataJSON() as ReadingPosition & {
        generation: string;
      };
      expect(position.generation).toBe(item.generation);
      item.position = {
        section: position.section,
        fraction: position.fraction,
      };
      saves.push(position);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: {} });
  });
  return saves;
}

test("opens Drive EPUB, blocks active content, adjusts text and resumes server-saved progress", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const outside: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("evil.test")) outside.push(request.url());
  });
  const saves = await driveShelf(page, [
    {
      id: "story",
      title: "A small story",
      format: "epub",
      buffer: await epubFixture(
        '<script>window.readerAttack=true</script><img src="https://evil.test/pixel"/><p onclick="alert(1)">Safe text</p>',
      ),
    },
  ]);
  await page.goto("/#/reading");
  await expect(
    page.getByRole("heading", { name: "Reading room." }),
  ).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: /A small story/ }).click();
  await expect(
    page.getByRole("heading", { name: "The quiet chapter" }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeHidden();
  await page.getByRole("button", { name: "Reading settings" }).click();
  await page.getByLabel("Text size").selectOption("28");
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-prose")).toHaveCSS("font-size", "28px");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A second morning" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to reading room" }).click();
  await expect(navigation).toBeVisible();
  await expect.poll(() => saves.length).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole("button", { name: /A small story.*Continue/ }).click();
  await expect(
    page.getByRole("heading", { name: "A second morning" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("ravan:reading:"),
      ),
    ),
  ).toEqual([]);
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test("reads Drive CBZ pages with right-to-left keyboard navigation on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=",
    "base64",
  );
  await driveShelf(page, [
    {
      id: "manga",
      title: "Manga",
      format: "cbz",
      buffer: await readingZip({ "10.png": png, "2.png": png, "1.png": png }),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Manga.*Open manga/ }).click();
  await expect(
    page.getByRole("img", { name: "Page 1 of Manga" }),
  ).toBeVisible();
  await expect(page.getByLabel("Reading direction")).toBeHidden();
  await page.getByRole("button", { name: "Reading settings" }).click();
  await expect(page.getByLabel("Reading direction")).toBeVisible();
  await expect(page.getByLabel("Reading direction")).toHaveValue("rtl");
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.locator(".reading-viewport").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("img", { name: "Page 2 of Manga" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Browse page index, page 2 of 3" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Back to reading room" }).click();
  await expect(
    page.getByRole("button", { name: /Continue · Page 2/ }),
  ).toBeFocused();
});

test("renders Drive PDFs with a local worker and rejects malformed Drive archives", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await driveShelf(page, [
    { id: "notes", title: "Notes", format: "pdf", buffer: pdfFixture() },
    {
      id: "broken",
      title: "Broken",
      format: "epub",
      buffer: Buffer.from("not a zip"),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Notes/ }).click();
  await expect(page.locator(".reading-pdf canvas")).toBeVisible();
  await expect(page.getByText("The reading room", { exact: true })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Back to reading room" }).click();
  await page.getByRole("button", { name: /Broken/ }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to read");
  expect(errors).toEqual([]);
});

test("searches Drive books, downloads the selected generation and saves progress", async ({
  page,
}) => {
  const saves = await driveShelf(page, [
    {
      id: "book",
      title: "Drive story",
      format: "epub",
      buffer: await epubFixture(),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("searchbox").fill("absent");
  await expect(page.getByText("No matching titles.")).toBeVisible();
  await page.getByRole("searchbox").fill("Drive");
  await page.getByRole("button", { name: /Drive story/ }).click();
  await expect(
    page.getByRole("heading", { name: "The quiet chapter" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A second morning" }),
  ).toBeVisible();
  await expect.poll(() => saves.length).toBeGreaterThan(0);
  expect(saves.at(-1)).toMatchObject({
    generation: "a".repeat(64),
    section: 1,
  });
});

test("empty preview directs the owner to Drive settings and offers no device imports", async ({
  page,
}) => {
  await page.goto("/?preview=1#/reading");
  await expect(page.getByText("Make room for your next story.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage Drive folder" }),
  ).toHaveAttribute("href", "#/settings");
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText("Open a file", { exact: true })).toHaveCount(0);
});

test("keeps a book open when saving fails and restores shelf focus after retry", async ({
  page,
}) => {
  await driveShelf(page, [
    {
      id: "book",
      title: "Notebook",
      format: "epub",
      buffer: await epubFixture(),
    },
  ]);
  const block = "**/api/reading/book/progress";
  await page.route(block, (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/#/reading");
  const card = page.getByRole("button", { name: /Notebook/ });
  await card.click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Back to reading room" }).click();
  await expect(page.getByText(/Your place could not be saved/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A second morning" }),
  ).toBeVisible();
  await page.unroute(block);
  await page.getByRole("button", { name: "Back to reading room" }).click();
  await expect(card).toBeFocused();
  await expect(card).toContainText("Continue · Chapter 2");
});

test("keeps the chapter language and resumes a long EPUB at the saved scroll position", async ({
  page,
}) => {
  const saves = await driveShelf(page, [
    {
      id: "long",
      title: "Long chapter",
      format: "epub",
      buffer: await epubFixture("<p>یک پاراگراف از کتاب</p>".repeat(90), "fa"),
    },
  ]);
  await page.goto("/#/reading");
  const card = page.getByRole("button", { name: /Long chapter/ });
  await card.click();
  const prose = page.locator(".reading-prose");
  await expect(prose).toHaveAttribute("lang", "fa");
  const viewport = page.getByRole("region", { name: "Chapter 1" });
  await expect(page.getByText("Opening chapter…")).toHaveCount(0);
  await viewport.evaluate((el) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.6;
  });
  await expect.poll(() => saves.at(-1)?.fraction ?? 0).toBeCloseTo(0.6, 2);
  await page.getByRole("button", { name: "Back to reading room" }).click();
  await card.click();
  await expect
    .poll(() =>
      viewport.evaluate(
        (el) => el.scrollTop / (el.scrollHeight - el.clientHeight),
      ),
    )
    .toBeCloseTo(0.6, 2);
});

test("fits a portrait PDF inside the reader and offers a larger width view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 680 });
  await driveShelf(page, [
    {
      id: "portrait",
      title: "Portrait scan",
      format: "pdf",
      buffer: pdfFixture(),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Portrait scan/ }).click();
  const canvas = page.locator(".reading-pdf canvas");
  await expect(canvas).toBeVisible();
  const region = page.getByRole("region", { name: "Page 1", exact: true });
  const fits = () =>
    region.evaluate(
      (el) =>
        el.scrollHeight <= el.clientHeight + 1 &&
        el.scrollWidth <= el.clientWidth + 1,
    );
  await expect.poll(fits).toBe(true);
  const size = page.getByLabel("Page size");
  await size.selectOption("width");
  await expect.poll(fits).toBe(false);
  await size.selectOption("page");
  await page.setViewportSize({ width: 320, height: 640 });
  await expect.poll(fits).toBe(true);
  const ratio = await canvas.evaluate((el) => el.clientWidth / el.clientHeight);
  expect(ratio).toBeCloseTo(0.75, 2);
});

test("browses manga previews without moving the bookmark until a page is chosen", async ({
  page,
}) => {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=",
    "base64",
  );
  const saves = await driveShelf(page, [
    {
      id: "pages",
      title: "Volume",
      format: "cbz",
      buffer: await readingZip(
        Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`${i + 1}.png`, image]),
        ),
      ),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Volume.*Open manga/ }).click();
  const index = page.getByRole("button", { name: /Browse page index/ });
  await index.click();
  const dialog = page.getByRole("dialog", { name: "Page index" });
  await expect(dialog.locator("canvas")).toHaveCount(6);
  await dialog.getByRole("button", { name: "Next group" }).click();
  await expect(dialog.locator("canvas")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(index).toBeFocused();
  expect(saves).toHaveLength(0);
  await index.click();
  await dialog.getByLabel("Go to page").fill("8");
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Page 8 of Volume" }),
  ).toBeVisible();
  await expect(index).toBeFocused();
});

test("renders a large PDF from ranges while the worker continues, then restores its status after reload", async ({
  page,
}) => {
  const bytes = pdfFixture(7 * 1024 * 1024);
  let total = 0;
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith("/content")) return;
    const slices = url.searchParams.get("slices");
    if (slices)
      total += slices
        .split(",")
        .reduce(
          (sum, s) => sum + Math.min(16384, bytes.length - Number(s) * 16384),
          0,
        );
    else {
      expect(response.status()).toBe(206);
      const [a, b] = response
        .request()
        .headers()
        .range!.slice(6)
        .split("-")
        .map(Number);
      total += b! - a! + 1;
    }
  });
  await driveShelf(page, [
    { id: "large", title: "Range edition", format: "pdf", buffer: bytes },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Range edition/ }).click();
  await expect(page.locator(".reading-pdf canvas")).toBeVisible();
  await expect(page.getByText(/Preparing 25%/)).toBeVisible();
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(bytes.length / 2);
  await page.reload();
  const card = page.getByRole("button", { name: /Range edition/ });
  await expect(card).toContainText("Preparing · 25%");
  await expect(
    card.getByRole("progressbar", { name: "Book preparation" }),
  ).toHaveAttribute("value", "25");
});

test("keeps a text selection on the page when the pointer is dragged past it", async ({
  page,
}) => {
  const paragraphs = Array.from(
    { length: 80 },
    (_, i) =>
      `<p>Line ${i} of a long chapter, written to be selected with a pointer.</p>`,
  ).join("");
  await driveShelf(page, [
    {
      id: "long",
      title: "Long chapter",
      format: "epub",
      buffer: await epubFixture(paragraphs),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Long chapter/ }).click();
  const start = page.getByText("Line 2 of a long chapter");
  await expect(start).toBeVisible();
  const viewport = (await page.locator(".reading-viewport").boundingBox())!;
  const from = (await start.boundingBox())!;
  const selected = () =>
    page.evaluate(() => {
      const selection = document.getSelection()!;
      return {
        text: String(selection),
        inPage: !!selection.focusNode?.parentElement?.closest(".reading-prose"),
      };
    });
  await page.mouse.move(from.x + 4, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y + 60, { steps: 4 });
  // Over the footer, then the top bar: both sit outside the scrolling page.
  for (const y of [viewport.y + viewport.height + 20, viewport.y - 20]) {
    await page.mouse.move(from.x + 120, y, { steps: 4 });
    // Before the fix the selection stayed on the end of the chapter or the
    // bar text for as long as the pointer was there.
    await expect
      .poll(async () => {
        const now = await selected();
        return (
          now.inPage &&
          !now.text.includes("Line 79") &&
          !/Chapter 1 of|Previous|Shelf/.test(now.text)
        );
      })
      .toBe(true);
  }
  // Back on the page, the selection still runs from where the drag began.
  const end = (await page.getByText("Line 5 of a long chapter").boundingBox())!;
  await page.mouse.move(end.x + 30, end.y + end.height / 2, { steps: 4 });
  await page.mouse.up();
  const last = await selected();
  expect(last.inPage).toBe(true);
  expect(last.text).toMatch(/Line 2 of[^]*Line 3 of[^]*Line 4 of/);
  expect(last.text).not.toContain("Line 6");
});

test("selects and copies the words of a PDF page by dragging across them", async ({
  page,
}) => {
  await driveShelf(page, [
    { id: "notes", title: "Notes", format: "pdf", buffer: pdfFixture() },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Notes/ }).click();
  const words = page.locator(".reading-pdf .textLayer span", {
    hasText: "The reading room",
  });
  await expect(words).toBeAttached();
  const canvas = (await page.locator(".reading-pdf canvas").boundingBox())!;
  const box = (await words.boundingBox())!;
  // The text sits where the page draws it: 60 points in, 100 points down.
  expect(Math.abs(box.x - canvas.x - (canvas.width * 60) / 600)).toBeLessThan(
    canvas.width * 0.02,
  );
  expect(box.y - canvas.y).toBeLessThan((canvas.height * 100) / 800);
  // From the first letter to the last one.
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  expect(
    await page.evaluate(() => String(document.getSelection()).trim()),
  ).toBe("The reading room");
});

test("a drag on a manga page does not pick the picture up", async ({
  page,
}) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=",
    "base64",
  );
  await driveShelf(page, [
    {
      id: "manga",
      title: "Manga",
      format: "cbz",
      buffer: await readingZip({ "1.png": png, "2.png": png }),
    },
  ]);
  await page.goto("/#/reading");
  await page.getByRole("button", { name: /Manga.*Open manga/ }).click();
  const picture = page.getByRole("img", { name: "Page 1 of Manga" });
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("draggable", "false");
  await page.evaluate(() => {
    (window as unknown as { drags: number }).drags = 0;
    document.addEventListener("dragstart", () => {
      (window as unknown as { drags: number }).drags++;
    });
  });
  const box = (await picture.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 40, {
    steps: 6,
  });
  await page.mouse.up();
  expect(
    await page.evaluate(() => (window as unknown as { drags: number }).drags),
  ).toBe(0);
});

test("shows each book's own cover on the shelf, and a drawn one without", async ({
  page,
}) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=",
    "base64",
  );
  const book = (id: string, coverUrl?: string): ReadingItem => ({
    id,
    title: id,
    name: `${id}.epub`,
    format: "epub",
    generation: "a".repeat(64),
    sizeBytes: "100",
    position: { section: 0, fraction: 0 },
    ...(coverUrl ? { coverUrl } : {}),
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: { authenticated: true, configured: true, csrfToken: "test" },
      });
    if (url.pathname === "/api/reading")
      return route.fulfill({
        json: {
          items: [
            book("Covered", `/api/artwork/${"a".repeat(32)}`),
            book("Plain"),
            book("Broken", `/api/artwork/${"b".repeat(32)}`),
          ],
          nextOffset: null,
        },
      });
    if (url.pathname === `/api/artwork/${"a".repeat(32)}`)
      return route.fulfill({ contentType: "image/png", body: png });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto("/#/reading");
  const card = (name: string) =>
    page.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(card("Covered").locator("img")).toHaveJSProperty(
    "complete",
    true,
  );
  expect(
    await card("Covered")
      .locator("img")
      .evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(1);
  await expect(card("Covered").locator(".reading-cover")).toHaveCSS(
    "aspect-ratio",
    "2 / 3",
  );
  // The picture fills the cover at every width, a phone's included.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const frame = (await card("Covered")
      .locator(".reading-cover")
      .boundingBox())!;
    const shown = (await card("Covered").locator("img").boundingBox())!;
    expect(shown.height).toBeCloseTo(frame.height, 0);
    expect(frame.width - shown.width).toBeLessThanOrEqual(8);
  }
  await expect(card("Plain").locator("img")).toHaveCount(0);
  await expect(card("Plain").locator(".reading-cover strong")).toHaveText(
    "Plain",
  );
  // A picture that cannot be fetched falls back to the drawn cover.
  await expect(card("Broken").locator("img")).toHaveCount(0);
  await expect(card("Broken").locator(".reading-cover strong")).toHaveText(
    "Broken",
  );
});
