import { test, expect, type Page } from "@playwright/test";
import { serveSyntheticMedia } from "./media.js";

/** One film, the 8-second synthetic one, with RAVAN's own controls. */
async function film(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "t" };
    else if (url.pathname === "/api/movies/f")
      body = {
        id: "f",
        title: "Night Transit",
        resumeMs: 0,
        available: true,
        description: "",
        saved: false,
        editions: [],
        tracks: [],
      };
    else if (url.pathname === "/api/playback")
      body = {
        kind: "ready",
        session: {
          id: "s",
          epoch: 1,
          mediaUrl: "/media/s/test/raw",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          startMs: 0,
        },
      };
    else if (url.pathname === "/api/progress") body = { status: "accepted" };
    else if (route.request().method() === "DELETE")
      return route.fulfill({ status: 204 });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await serveSyntheticMedia(page);
  await page.goto("/#/player/f");
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  // The player starts the film itself; begin each test paused at the start.
  await video.evaluate((v) => {
    const media = v as HTMLVideoElement;
    media.muted = true;
    media.pause();
    media.currentTime = 0;
  });
  return video;
}
const paused = (page: Page) =>
  page.locator("video").evaluate((v) => (v as HTMLVideoElement).paused);

test("a click in the middle plays and pauses, and a pause is an intermission", async ({
  page,
}) => {
  await film(page);
  // Paused, the middle offers the way back in.
  await page.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => paused(page)).toBe(false);
  // A click in the middle of the picture pauses; the glyph shows what happened.
  const stage = page.locator(".stage");
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await expect.poll(() => paused(page)).toBe(true);
  await expect(page.locator(".stage-flash")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page.locator(".intermission-note")).toContainText(
    "Night Transit",
  );
  await expect(page.locator(".intermission-note")).toContainText(/Paused at/);
  // And plays again from the middle.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await expect.poll(() => paused(page)).toBe(false);
});

test("the seek line is a slider; the bar fades while playing and returns", async ({
  page,
}) => {
  const video = await film(page);
  const seek = page.getByRole("slider", { name: "Position in the film" });
  await expect(seek).toHaveAttribute("aria-valuemax", "8");
  await seek.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(6);
  await page.keyboard.press("Home");
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeLessThan(1);
  // A click on the line goes there.
  const line = (await seek.boundingBox())!;
  await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(3);
  // Playing, untouched: the controls step aside, and any movement brings them back.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.mouse.move(5, 5);
  await video.evaluate((v) => {
    const media = v as HTMLVideoElement;
    media.currentTime = 0;
    void media.play();
  });
  await expect(page.locator(".transport")).toHaveClass(/is-hidden/, {
    timeout: 6000,
  });
  const stage = (await page.locator(".stage").boundingBox())!;
  await page.mouse.move(stage.x + 40, stage.y + 40);
  await expect(page.locator(".transport")).not.toHaveClass(/is-hidden/);
});

test("the time shows what is left on a press, and the full-screen button works", async ({
  page,
  browserName,
}) => {
  await film(page);
  const time = page.locator(".transport-time");
  await expect(time).toContainText("0:00");
  await time.click();
  await expect(time).toContainText("−0:08");
  if (browserName !== "chromium") return;
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement?.className ?? ""),
    )
    .toContain("player-frame");
  // The title rides with the controls in full screen.
  await expect(page.locator(".transport-title")).toHaveText("Night Transit");
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
});

test("a browser that refuses the frame full screen gets the picture full screen", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "full screen runs in Chromium here");
  await page.addInitScript(() => {
    // As some embedded TV browsers do: only the video may go full screen.
    const original = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (
      this: Element,
      options?: FullscreenOptions,
    ) {
      if (this.tagName !== "VIDEO")
        return Promise.reject(new TypeError("Not allowed"));
      return original.call(this, options);
    };
  });
  await film(page);
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.tagName))
    .toBe("VIDEO");
  // The browser's own controls come with the picture, and leave with it.
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator("video")).not.toHaveAttribute("controls", "");
});
