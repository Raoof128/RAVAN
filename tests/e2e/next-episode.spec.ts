import { test, expect, type Page } from "@playwright/test";
import { serveSyntheticMedia } from "./media.js";

/**
 * A season of two episodes in a folder, played with the 8-second synthetic
 * film. Records what the player asks of the API.
 */
async function season(page: Page, autoplayNext = true) {
  const seen = {
    playback: [] as Array<{ movieId: string; replaceSessionId?: string }>,
    saved: [] as Array<Record<string, unknown>>,
  };
  const episode = (id: string, n: number) => ({
    id,
    title: `Fire Force - S03E0${n}`,
    resumeMs: 0,
    available: true,
    description: "",
    saved: false,
    editions: [],
    tracks: [],
    episode: {
      season: 3,
      episode: n,
      index: n,
      count: 2,
      folder: { id: "ff3", name: "Fire Force - Season 3" },
      ...(n === 1
        ? {
            next: {
              id: "e2",
              title: "Fire Force - S03E02",
              resumeMs: 0,
              available: true,
              season: 3,
              episode: 2,
            },
          }
        : {}),
    },
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    let body: unknown = {};
    if (url.pathname === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (url.pathname === "/api/movies/e1") body = episode("e1", 1);
    else if (url.pathname === "/api/movies/e2") body = episode("e2", 2);
    else if (url.pathname === "/api/preferences") {
      if (method === "PUT") seen.saved.push(route.request().postDataJSON());
      body = {
        audioLanguage: "original",
        subtitleLanguage: "off",
        quality: "original",
        reducedMotion: false,
        autoplayNext,
      };
    } else if (url.pathname === "/api/playback") {
      const request = route.request().postDataJSON();
      seen.playback.push({
        movieId: request.movieId,
        replaceSessionId: request.replaceSessionId,
      });
      body = {
        kind: "ready",
        session: {
          id: `session-${request.movieId}`,
          epoch: seen.playback.length,
          mediaUrl: "/media/s/test/raw",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          startMs: 0,
        },
      };
    } else if (url.pathname === "/api/progress") body = { status: "accepted" };
    else if (method === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await serveSyntheticMedia(page);
  return seen;
}

async function playToTheEnd(page: Page) {
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate(async (v) => {
    const media = v as HTMLVideoElement;
    media.muted = true;
    media.currentTime = 6.5;
    await media.play();
  });
}

test("an episode's end offers the next one, and Play now opens it in place", async ({
  page,
}) => {
  const seen = await season(page);
  await page.goto("/#/player/e1");
  await expect(page.getByText("Season 3, episode 1 of 2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Next episode/ }),
  ).toBeVisible();
  await playToTheEnd(page);
  const panel = page.getByRole("region", { name: "Fire Force - S03E02" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^Plays in \d+ s$/)).toBeVisible();
  // OK on a remote plays it: the button has the focus.
  await expect(panel.getByRole("button", { name: "Play now" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/player\/e2$/);
  await expect(
    page.getByRole("heading", { name: "Fire Force - S03E02", level: 1 }),
  ).toBeVisible();
  // The next episode replaces the finished one's session: no conflict.
  await expect
    .poll(() => seen.playback.at(-1))
    .toEqual({ movieId: "e2", replaceSessionId: "session-e1" });
  // The last episode has nothing after it.
  await expect(page.getByRole("button", { name: /Next episode/ })).toHaveCount(
    0,
  );
});

test("the next episode plays on its own after the line has flowed", async ({
  page,
}) => {
  test.setTimeout(45000);
  await season(page);
  await page.goto("/#/player/e1");
  await playToTheEnd(page);
  await expect(page.getByText(/^Plays in \d+ s$/)).toBeVisible();
  await expect(page).toHaveURL(/#\/player\/e2$/, { timeout: 15000 });
});

test("Not now stops the count, and one press turns playing on its own off", async ({
  page,
}) => {
  const seen = await season(page);
  await page.goto("/#/player/e1");
  await playToTheEnd(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText(/^Plays in \d+ s$/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play next episode" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to Fire Force - Season 3" }),
  ).toHaveAttribute("href", "#/folder/ff3");
  await page.waitForTimeout(11000);
  await expect(page).toHaveURL(/#\/player\/e1$/);

  // Again, choosing never to count.
  await page.getByRole("button", { name: "Watch again" }).click();
  await playToTheEnd(page);
  await page
    .getByRole("button", { name: "Don’t play episodes on their own" })
    .click();
  await expect.poll(() => seen.saved.at(-1)?.autoplayNext).toBe(false);
  await expect(page.getByText(/^Plays in \d+ s$/)).toHaveCount(0);
});

test("with playing on its own off, the end waits with the next episode ready", async ({
  page,
}) => {
  await season(page, false);
  await page.goto("/#/player/e1");
  await playToTheEnd(page);
  await expect(
    page.getByRole("button", { name: "Play next episode" }),
  ).toBeFocused();
  await expect(page.getByText(/^Plays in \d+ s$/)).toHaveCount(0);
  // Shift+N goes to the next episode from anywhere in the player.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("Shift+N");
  await expect(page).toHaveURL(/#\/player\/e2$/);
});
