import { test, expect } from "@playwright/test";
for (const width of [390, 768, 1440]) {
  test(`catalogue at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?preview=1");
    await expect(
      page.getByRole("heading", {
        name: "The Quiet Coast",
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    // Visit lazy posters as a viewer would before capturing the whole page.
    // A full-page screenshot alone does not trigger offscreen image loading.
    for (const img of await page.locator(".poster img").all()) {
      await img.scrollIntoViewIfNeeded();
      await expect
        .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((a) => a.finished.catch(() => {})),
      ),
    );
    if (test.info().project.name === "chromium")
      await page.screenshot({
        path: `docs/testing/screenshots/library-${width}.png`,
        fullPage: true,
      });
    await page.getByRole("searchbox").fill("night");
    await expect(
      page.getByRole("heading", { name: "Night Transit", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Other Skies", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "View Night Transit" }).click();
    await expect(
      page.getByRole("heading", { name: "Night Transit", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "+ Watchlist" }).click();
    await expect(
      page.getByRole("button", { name: "✓ In watchlist" }),
    ).toBeVisible();
  });
}
test("keyboard navigation and reduced motion remain usable", async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preview=1");
  await expect(
    page.getByRole("heading", { name: "The Quiet Coast", level: 1 }),
  ).toBeVisible();
  // macOS WebKit uses Option-Tab for links unless full keyboard access is enabled.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  // macOS WebKit uses Option-Tab for links unless full keyboard access is enabled.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(page.getByRole("link", { name: "RAVAN home" })).toBeFocused();
  await page.getByRole("link", { name: "Your cinema", exact: true }).click();
  await expect(page.getByLabel("Drive folder ID")).toBeVisible();
});
test("200 percent equivalent layout has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 500 });
  await page.goto("/?preview=1");
  await expect(
    page.getByText("The collection", { exact: false }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
