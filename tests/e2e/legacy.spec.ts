import { test, expect } from "@playwright/test";
// The flex-gap stand-in for Chromium 79 (packages/client/src/legacy.ts) must
// stay off in every current engine, which lay out `gap` themselves.
test("current browsers keep their own flex gap", async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(
    page.getByRole("heading", { name: "The Quiet Coast", level: 1 }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.documentElement.getAttribute("data-flex-gap"),
    ),
  ).toBeNull();
  // Current engines know :focus-visible; the :focus stand-in stays off.
  expect(
    await page.evaluate(() =>
      document.documentElement.getAttribute("data-focus-visible"),
    ),
  ).toBeNull();
  // The filled-in abort functions defer to the browser's own.
  expect(
    await page.evaluate(() =>
      String(AbortSignal.any).includes("[native code]"),
    ),
  ).toBe(true);
});
