import { test, expect, type Page } from "@playwright/test";

const film = (id: string, title: string) => ({
  id,
  title,
  resumeMs: 0,
  available: true,
});
const episodes = [
  film("e1", "Pluto 01"),
  film("e2", "Pluto 02"),
  film("e3", "Pluto 03"),
];
/** A cinema with one film at the top and a "Pluto" folder of episodes. */
async function cinema(page: Page) {
  const asked: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (path === "/api/movies") {
      const folder = url.searchParams.get("folder");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      asked.push(folder ?? "all");
      body =
        folder === "root"
          ? {
              items: [film("top", "Night Transit")],
              nextCursor: null,
              folder: { id: "root", name: "Movies", parentId: null },
              folders: [{ id: "pluto", name: "Pluto", films: 3 }],
            }
          : folder === "pluto"
            ? {
                items: episodes.filter((m) =>
                  m.title.toLowerCase().includes(q),
                ),
                nextCursor: null,
                folder: { id: "pluto", name: "Pluto", parentId: "root" },
                ...(q ? {} : { folders: [] }),
              }
            : {
                items: [film("top", "Night Transit"), ...episodes].filter((m) =>
                  m.title.toLowerCase().includes(q),
                ),
                nextCursor: null,
              };
    } else if (path.startsWith("/api/movies/")) {
      const id = path.split("/").pop()!;
      body = {
        ...(episodes.find((m) => m.id === id) ?? film(id, "Night Transit")),
        description: "",
        saved: false,
        editions: [],
        tracks: [],
      };
    } else if (path === "/api/library")
      body = { folderId: "root", state: "succeeded", counts: {} };
    await route.fulfill({ json: body });
  });
  return asked;
}

test("a folder is one card that opens to its films, and back returns to it", async ({
  page,
}) => {
  const asked = await cinema(page);
  await page.goto("/#/library");
  const pluto = page.getByRole("link", {
    name: "Open the folder Pluto, 3 films",
  });
  await expect(pluto).toBeVisible();
  // The episodes are inside the folder, not loose in the collection.
  await expect(page.getByRole("link", { name: "View Pluto 01" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "View Night Transit" }),
  ).toBeVisible();

  await pluto.click();
  await expect(page).toHaveURL(/#\/folder\/pluto$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /Pluto/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^View Pluto/ })).toHaveCount(3);
  await expect(page).toHaveTitle(/^Pluto — RAVAN/);

  // A search inside the folder asks about that folder only.
  await page.getByRole("searchbox", { name: "Search this folder" }).fill("02");
  await expect(page.getByRole("link", { name: /^View Pluto/ })).toHaveCount(1);
  expect(asked.at(-1)).toBe("pluto");
  await page.getByRole("searchbox", { name: "Search this folder" }).fill("");

  // From an episode, "back" returns to the folder rather than the top.
  await page.getByRole("link", { name: "View Pluto 01" }).click();
  await expect(page).toHaveURL(/#\/movie\/e1$/);
  await page.getByRole("link", { name: "Back to the collection" }).click();
  await expect(page).toHaveURL(/#\/folder\/pluto$/);

  await page.getByRole("link", { name: "Back to the collection" }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(pluto).toBeVisible();

  // A search from the top still looks through every folder.
  await page
    .getByRole("searchbox", { name: "Search your movies" })
    .fill("pluto");
  await expect(page.getByRole("link", { name: /^View Pluto/ })).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: /^Open the folder/ }),
  ).toHaveCount(0);
  expect(asked.at(-1)).toBe("all");
});
