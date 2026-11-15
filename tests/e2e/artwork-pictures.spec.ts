import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Two pictures the worker would have made: a poster and a wide still. The
// bundled sample artwork stands in for frames of a real film.
const poster = "a".repeat(32),
  still = "b".repeat(32);
async function cinema(page: Page, seen: string[] = []) {
  const images = {
    [poster]: await readFile("packages/ui/src/art/rain.webp"),
    [still]: await readFile("packages/ui/src/art/coast-hero.webp"),
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = path.split("/").pop()!;
    if (path.startsWith("/api/artwork/")) {
      seen.push(route.request().headers()["authorization"] ?? "cookie");
      return route.fulfill({
        status: images[id] ? 200 : 404,
        // The server sends JPEG; the bytes here are WebP, which every engine reads.
        contentType: "image/jpeg",
        body: images[id] ?? "",
      });
    }
    const film = {
      id: "film",
      title: "Harbour Lights",
      year: 2016,
      resumeMs: 0,
      available: true,
      posterUrl: `/api/artwork/${poster}`,
      posterTitled: true,
      stillUrl: `/api/artwork/${still}`,
    };
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "t" };
    else if (path === "/api/movies") body = { items: [film], nextCursor: null };
    else if (path === "/api/movies/film")
      body = {
        ...film,
        description: "",
        saved: false,
        editions: [],
        tracks: [],
      };
    await route.fulfill({ json: body });
  });
}
const loaded = (page: Page, selector: string) =>
  expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBeGreaterThan(0);

test("the library shows each film's pictures, with the title set over a frame", async ({
  page,
}) => {
  await cinema(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Harbour Lights", level: 1 }),
  ).toBeVisible();
  // The wide still behind the hero, the poster on the card.
  await expect(page.locator(".feature > img")).toHaveAttribute(
    "src",
    `/api/artwork/${still}`,
  );
  await loaded(page, ".feature > img");
  const card = page.locator(".poster-grid .poster").first();
  await expect(card).toHaveClass(/poster-illustrated/);
  await expect(card.locator("img")).toHaveAttribute(
    "src",
    `/api/artwork/${poster}`,
  );
  await loaded(page, ".poster-grid .poster img");
  await expect(card.locator(".poster-title")).toBeVisible();
  // The film page uses the same still behind it.
  await page.getByRole("link", { name: "View Harbour Lights" }).click();
  await expect(page.locator(".detail-atmosphere img")).toHaveAttribute(
    "src",
    `/api/artwork/${still}`,
  );
});

test("the TV fetches pictures with its own credential", async ({ page }) => {
  const seen: string[] = [];
  await cinema(page, seen);
  await page.addInitScript(() =>
    localStorage.setItem("mov-device", "device-credential"),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("http://127.0.0.1:5174/");
  await expect(page.locator('[data-focus-id="movie-film"]')).toBeFocused();
  await loaded(page, ".tv-grid .poster img");
  await expect(page.locator(".tv-grid .poster img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await loaded(page, ".tv-library-atmosphere img");
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(new Set(seen)).toEqual(new Set(["Bearer device-credential"]));
});
