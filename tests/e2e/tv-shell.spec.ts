import { serveSyntheticMedia } from "./media.js";
import { test, expect } from "@playwright/test";
test("LG C1 shell supports directional browsing, Back and focus restoration", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("http://127.0.0.1:5174/?preview=1");
  const first = page.locator('[data-focus-id="movie-sample-0"]');
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const second = page.locator('[data-focus-id="movie-sample-1"]');
  await expect(second).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Night Transit" }),
  ).toBeVisible();
  await expect(page.locator('[data-focus-id="watch"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(second).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `docs/testing/screenshots/tv-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("Back retains a film from the second catalogue page", async ({ page }) => {
  const first = Array.from({ length: 40 }, (_, i) => ({
    id: `f-${i}`,
    title: `Film ${i}`,
    available: true,
    resumeMs: 0,
  }));
  const late = {
    id: "late",
    title: "The forty-first film",
    available: true,
    resumeMs: 0,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const body =
      url.pathname === "/api/session"
        ? { authenticated: true, configured: true }
        : url.pathname === "/api/movies"
          ? url.searchParams.get("cursor")
            ? { items: [late], nextCursor: null }
            : { items: first, nextCursor: "next" }
          : {
              ...late,
              description: "Local fixture",
              saved: false,
              editions: [],
              tracks: [],
            };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("http://127.0.0.1:5174/");
  await page.getByRole("button", { name: "More films", exact: true }).click();
  const item = page.locator('[data-focus-id="movie-late"]');
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "The forty-first film" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(item).toBeFocused();
  await page.waitForTimeout(200);
  await expect(item).toBeVisible();
  await expect(item).toBeFocused();
});

test("TV reconnect and close/reopen preserve the actual playback position", async ({
  page,
}) => {
  const starts: number[] = [];
  let progress = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, "PalmSystem", { value: {} });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const movie = {
      id: "film",
      title: "TV resume fixture",
      available: true,
      resumeMs: progress,
      description: "Local fixture",
      saved: false,
      editions: [],
      tracks: [],
    };
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true };
    else if (path === "/api/movies")
      body = { items: [movie], nextCursor: null };
    else if (path === "/api/movies/film") body = movie;
    else if (path === "/api/playback") {
      starts.push(route.request().postDataJSON().startMs);
      body = {
        kind: "ready",
        session: {
          id: "session",
          epoch: 1,
          mediaUrl: "/media/s/test/raw",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          startMs: starts[starts.length - 1],
        },
      };
    } else if (path === "/api/progress") {
      progress = route.request().postDataJSON().positionMs;
      body = { status: "accepted" };
    } else if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await serveSyntheticMedia(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("http://127.0.0.1:5174/");
  await page.locator('[data-focus-id="movie-film"]').click();
  await page.locator('[data-focus-id="watch"]').click();
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() =>
      video.evaluate((v) => {
        const media = v as HTMLVideoElement;
        return media.seekable.length ? media.seekable.end(0) : 0;
      }),
    )
    .toBeGreaterThan(6);
  await video.evaluate(
    (v) =>
      new Promise<void>((resolve) => {
        const media = v as HTMLVideoElement;
        media.addEventListener(
          "seeked",
          () => {
            media.pause();
            resolve();
          },
          { once: true },
        );
        media.currentTime = 4;
      }),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "Reconnect playback" }).click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toBeGreaterThanOrEqual(3900);
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate(
    (v) =>
      new Promise<void>((resolve) => {
        const media = v as HTMLVideoElement;
        media.addEventListener(
          "seeked",
          () => {
            media.pause();
            resolve();
          },
          { once: true },
        );
        media.currentTime = 5;
      }),
  );
  await page.getByRole("button", { name: "Close film", exact: true }).click();
  await page.locator('[data-focus-id="watch"]').click();
  await expect.poll(() => starts.length).toBe(3);
  expect(starts[2]).toBeGreaterThanOrEqual(4900);
});
