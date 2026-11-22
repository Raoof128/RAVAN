import { test, expect, type Page } from "@playwright/test";
import type {
  ReadingItem,
  ReadingList,
} from "../../packages/contracts/src/reading.js";

const book = (id: string, title: string, section = 0): ReadingItem => ({
  id,
  title,
  name: `${title}.pdf`,
  format: "pdf",
  generation: "a".repeat(64),
  sizeBytes: "1000",
  position: { section, fraction: 0 },
  preparation: { state: "on-demand", percent: 0 },
});

/** A reading room with two folders of manga, as the owner's Drive has. */
async function room(page: Page) {
  const asked: Array<{ q: string; folder: string | null }> = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: { authenticated: true, configured: true, csrfToken: "t" },
      });
    if (url.pathname === "/api/reading") {
      const q = url.searchParams.get("q") ?? "";
      const folder = url.searchParams.get("folder");
      asked.push({ q, folder });
      const list: ReadingList =
        folder === "root"
          ? {
              items: [book("loose", "A loose book")],
              nextOffset: null,
              folder: { id: "root", name: "Library", parentId: null },
              folders: [
                { id: "berserk", name: "Berserk", books: 2 },
                { id: "punpun", name: "Oyasumi Punpun", books: 13 },
              ],
              reading: [book("p3", "Punpun 03", 41)],
            }
          : folder === "berserk"
            ? {
                items: [
                  book("b1", "Berserk Vol 01"),
                  book("b2", "Berserk Vol 02"),
                ],
                nextOffset: null,
                folder: { id: "berserk", name: "Berserk", parentId: "root" },
                folders: [],
              }
            : {
                items: [book("b1", "Berserk Vol 01"), book("p1", "Punpun 01")],
                nextOffset: null,
              };
      return route.fulfill({ json: list });
    }
    return route.fulfill({ json: {} });
  });
  return asked;
}

test("the reading room shows its folders as stacks that open to their books", async ({
  page,
}) => {
  const asked = await room(page);
  await page.goto("/#/reading");
  // The book being read leads, wherever it is filed.
  const continuing = page.getByRole("region", { name: "Continue reading" });
  await expect(
    continuing.getByRole("button", { name: /Punpun 03/ }),
  ).toContainText("Continue · Page 42");
  // Each folder is one card; the top's own book sits beside them.
  await expect(
    page.getByRole("link", {
      name: "Open the folder Oyasumi Punpun, 13 books",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /A loose book/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Berserk Vol 01/ }),
  ).toHaveCount(0);

  await page
    .getByRole("link", { name: "Open the folder Berserk, 2 books" })
    .click();
  await expect(page).toHaveURL(/#\/reading\/folder\/berserk$/);
  await expect(
    page.getByRole("heading", { name: "Berserk", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Berserk Vol 01/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Berserk Vol 02/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Reading room", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Back to the reading room" }).click();
  await expect(page).toHaveURL(/#\/reading$/);
  await expect(
    page.getByRole("link", { name: "Open the folder Berserk, 2 books" }),
  ).toBeVisible();

  // From the top a search looks through every book, in every folder.
  await page.getByLabel("Search your books").fill("01");
  await expect(page.getByRole("button", { name: /Punpun 01/ })).toBeVisible();
  expect(asked.at(-1)).toEqual({ q: "01", folder: null });
  await expect(
    page.getByRole("region", { name: "Continue reading" }),
  ).toHaveCount(0);
});
