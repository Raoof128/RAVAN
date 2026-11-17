import { test, expect } from "@playwright/test";

test("RAVAN artwork loads locally and details retain the cinematic identity", async ({
  page,
}) => {
  const externalImages: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "image" &&
      !request.url().startsWith("http://127.0.0.1:5173/")
    )
      externalImages.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?preview=1");
  await expect(page).toHaveTitle("RAVAN. Every Story Flows.");
  const hero = page.locator(".feature > img");
  await expect(hero).toHaveAttribute("fetchpriority", "high");
  await expect
    .poll(() => hero.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page.locator(".poster-grid").scrollIntoViewIfNeeded();
  await expect(page.locator(".poster-illustrated")).toHaveCount(6);
  await expect
    .poll(() =>
      page
        .locator(".poster img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  expect(externalImages).toEqual([]);
  await page
    .getByRole("link", { name: "View The Quiet Coast", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "The Quiet Coast", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Resume film", exact: false }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/testing/screenshots/detail-1440.png",
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/testing/screenshots/detail-390.png",
      fullPage: true,
    });
});

test("missing artwork keeps readable titles and usable navigation", async ({
  page,
}) => {
  await page.route("**/*.webp", (route) => route.abort());
  await page.goto("/?preview=1");
  await expect(page.locator(".feature .film-still-fallback")).toBeVisible();
  await page.locator(".poster-grid").scrollIntoViewIfNeeded();
  await expect(page.locator(".poster-photographic")).toHaveCount(0);
  await page
    .getByRole("link", { name: "View Night Transit", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Night Transit", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Watchlist" })).toBeEnabled();
});

test("narrow brand header and setup remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/?preview=1");
  await expect(page.getByRole("link", { name: "RAVAN home" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Your cinema", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { authenticated: false, configured: false } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your cinema. Only yours." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
