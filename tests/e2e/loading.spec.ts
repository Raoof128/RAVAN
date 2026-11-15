import { serveSyntheticMedia } from "./media.js";
import { test, expect, type Page, type Route } from "@playwright/test";

const film = (i: number, extra: object = {}) => ({
  id: `film-${i}`,
  title: [
    "The Long Way Home",
    "Harbour Lights",
    "A Quiet Hour",
    "The Lord of the Rings: The Fellowship of the Ring (Extended Edition)",
  ][i % 4],
  year: 2001 + i,
  resumeMs: i === 0 ? 1320000 : i === 2 ? 2640000 : 0,
  available: true,
  ...extra,
});
const detail = (i = 0) => ({
  ...film(i),
  description: "A film from the library.",
  saved: false,
  editions: [
    {
      id: "e",
      label: "Original",
      state: "source",
      sourceId: "s",
      available: true,
    },
  ],
  tracks: [],
  audioTracks: [],
});
type Handler = (route: Route, path: string) => unknown;
/** A signed-in cinema with eight films; `custom` answers first when it returns a value. */
async function cinema(page: Page, custom?: Handler) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const own = await custom?.(route, path);
    if (own === true) return;
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (path === "/api/movies")
      body = {
        items: Array.from({ length: 8 }, (_, i) => film(i)),
        nextCursor: null,
      };
    else if (path.startsWith("/api/movies/")) body = detail();
    else if (path === "/api/library")
      body = { folderId: "folder", state: "succeeded", counts: { upserts: 8 } };
    else if (path === "/api/preferences")
      body = {
        audioLanguage: "original",
        subtitleLanguage: "off",
        quality: "original",
        reducedMotion: false,
      };
    else if (path === "/api/devices")
      body = [{ id: "tv", name: "Living room" }];
    await route.fulfill({ json: body });
  });
}
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const capture = (name: string) =>
  test.info().project.name === "chromium"
    ? { path: `docs/testing/screenshots/${name}.png` }
    : undefined;

test("the opening screen covers the session check and leaves the moment it is answered", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await cinema(page, async (route, path) => {
    if (path !== "/api/session") return;
    await held;
    await route.fulfill({
      json: { authenticated: false, configured: true },
    });
    return true;
  });
  await page.goto("/");
  const boot = page.locator("#boot");
  await expect(boot).toBeVisible();
  await expect(boot.getByText("Opening your cinema")).toBeVisible();
  // Nothing behind it can be reached while it is up.
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveCount(0);
  const shot = capture("loading-opening-1280");
  if (shot) await page.screenshot(shot);
  const released = Date.now();
  release();
  await expect(
    page.getByRole("heading", { name: "Your cinema. Only yours." }),
  ).toBeVisible();
  await expect(boot).toHaveCount(0);
  // The screen is not held back to show the mark: a fade, nothing more.
  expect(Date.now() - released).toBeLessThan(2500);
});

test("a fast visit never shows the opening mark", async ({ page }) => {
  await cinema(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("#boot")).toHaveCount(0);
});

test("library placeholders hold the page still until the films arrive", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await cinema(page, async (route, path) => {
    if (path !== "/api/movies") return;
    await held;
    return;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".movie-card.is-placeholder")).toHaveCount(12);
  await expect(page.getByText("Loading your films")).toBeAttached();
  const shot = capture("loading-library-1440");
  if (shot) await page.screenshot(shot);
  release();
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".movie-card.is-placeholder")).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
});

test("the hero keeps its height between placeholder and film", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await cinema(page, async (route, path) => {
    if (path !== "/api/movies") return;
    await held;
    await route.fulfill({ json: { items: [film(1)], nextCursor: null } });
    return true;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".movie-card.is-placeholder")).toHaveCount(12);
  const waiting = await page.locator("#collection").boundingBox();
  release();
  await expect(
    page.getByRole("heading", { name: "Harbour Lights", level: 1 }),
  ).toBeVisible();
  const settled = await page.locator("#collection").boundingBox();
  expect(Math.abs(settled!.y - waiting!.y)).toBeLessThanOrEqual(1);
});

test("preparation shows the server's own steps and percentage, and nothing it did not send", async ({
  page,
}) => {
  let calls = 0;
  await cinema(page, async (route, path) => {
    if (path !== "/api/playback") return;
    calls++;
    await route.fulfill({
      status: 202,
      json:
        calls === 1
          ? {
              kind: "preparing",
              jobId: "job",
              progress: 37.6,
              phase: "converting",
              reason: "Creating a browser-compatible edition.",
            }
          : {
              kind: "preparing",
              jobId: "job",
              progress: 61,
              phase: "buffering",
              reason: "Nearly there.",
            },
    });
    return true;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/player/film-0");
  await expect(
    page.getByRole("heading", { name: "Getting your film ready" }),
  ).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "37");
  await expect(page.getByText("37% prepared")).toBeVisible();
  const steps = page.getByRole("list", { name: "Preparation steps" });
  await expect(steps.locator('[aria-current="step"]')).toContainText(
    "Convert for this screen",
  );
  await expect(steps.locator('[data-state="done"]')).toHaveCount(2);
  await expect(page.locator(".stage")).not.toContainText(
    /remaining|left|fps|speed|about \d/i,
  );
  await expect(page).toHaveTitle("The Long Way Home — RAVAN");
  const wide = capture("player-preparing-1440");
  if (wide) await page.screenshot(wide);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noOverflow(page)).toBe(true);
  const narrow = capture("player-preparing-390");
  if (narrow) await page.screenshot({ ...narrow, fullPage: true });
  // Between the server's answers the panel stays where it is.
  await page.evaluate(() => {
    const w = window as unknown as { gaps: number };
    w.gaps = 0;
    new MutationObserver(() => {
      if (!document.querySelector(".preparing")) w.gaps++;
    }).observe(document.querySelector(".stage")!, {
      childList: true,
      subtree: true,
    });
  });
  // The next answer from the server moves the step; the page does not guess ahead.
  await expect(steps.locator('[aria-current="step"]')).toContainText(
    "Start the film",
    { timeout: 12000 },
  );
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "61");
  expect(
    await page.evaluate(() => (window as unknown as { gaps: number }).gaps),
  ).toBe(0);
});

test("a screen whose code fails to load says so and lets the owner carry on", async ({
  page,
}) => {
  await cinema(page);
  await page.route("**/pages/Settings.tsx*", (route) => route.abort());
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Your cinema", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "This screen couldn’t be opened." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // The rest of the cinema still works.
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
});

test("a film that is only queued shows no percentage at all", async ({
  page,
}) => {
  await cinema(page, async (route, path) => {
    if (path !== "/api/playback") return;
    await route.fulfill({
      status: 202,
      json: {
        kind: "preparing",
        jobId: "job",
        progress: 0,
        phase: "queued",
        reason: "Queued for automatic preparation.",
      },
    });
    return true;
  });
  await page.goto("/#/player/film-0");
  await expect(
    page
      .getByRole("list", { name: "Preparation steps" })
      .locator('[aria-current="step"]'),
  ).toContainText("Wait for the server");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator(".stage")).not.toContainText("%");
  await expect(page.locator(".stage .flow")).toBeVisible();
});

test("the saved motion preference and the system setting both still the interface", async ({
  page,
}) => {
  await cinema(page, async (route, path) => {
    if (path !== "/api/preferences") return;
    await route.fulfill({
      json: {
        audioLanguage: "original",
        subtitleLanguage: "off",
        quality: "original",
        reducedMotion: true,
      },
    });
    return true;
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
  const animated = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("*")).filter((node) => {
        const style = getComputedStyle(node);
        return (
          style.animationName !== "none" ||
          parseFloat(style.transitionDuration) > 0
        );
      }).length,
  );
  expect(animated).toBe(0);
  // The system setting alone, before any preference is known.
  const context = await page.context().browser()!.newContext({
    reducedMotion: "reduce",
  });
  const fresh = await context.newPage();
  await fresh.route("**/api/session", () => {});
  await fresh.goto("http://127.0.0.1:5173/");
  await expect(fresh.locator("#boot")).toBeVisible();
  expect(
    await fresh.evaluate(
      () =>
        getComputedStyle(document.querySelector("#boot i")!, ":before")
          .animationName,
    ),
  ).toBe("none");
  await context.close();
});

test("a new screen takes focus, names the tab, and Tab continues from its top", async ({
  page,
}) => {
  await cinema(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Your cinema", exact: true }).click();
  await expect(page.getByLabel("Drive folder ID")).toBeVisible();
  await expect(page).toHaveTitle("Your cinema — RAVAN");
  await expect(page.locator(".view")).toBeFocused();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page).toHaveTitle("RAVAN — Every Story Flows.");
  await page.getByRole("link", { name: "View Harbour Lights" }).first().click();
  await expect(page).toHaveTitle("The Long Way Home — RAVAN");
  await expect(page.locator(".view")).toBeFocused();
});

test("a session that ends mid-visit returns to sign-in instead of a broken page", async ({
  page,
}) => {
  let ended = false;
  await cinema(page, async (route, path) => {
    if (!ended) return;
    if (path === "/api/session")
      await route.fulfill({ json: { authenticated: false, configured: true } });
    else
      await route.fulfill({ status: 401, json: { error: "unauthenticated" } });
    return true;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "The Long Way Home", level: 1 }),
  ).toBeVisible();
  ended = true;
  await page.getByRole("searchbox").fill("harbour");
  await expect(
    page.getByRole("heading", { name: "Your cinema. Only yours." }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
});

test("the player answers the same keys in every browser", async ({ page }) => {
  await cinema(page, async (route, path) => {
    if (path === "/api/playback") {
      await route.fulfill({
        json: {
          kind: "ready",
          session: {
            id: "session",
            epoch: 1,
            mediaUrl: "/media/s/test/raw",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            startMs: 0,
          },
        },
      });
      return true;
    }
    if (path === "/api/progress") {
      await route.fulfill({ json: { status: "accepted" } });
      return true;
    }
    return;
  });
  await serveSyntheticMedia(page);
  await page.goto("/#/player/film-1");
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  const state = () =>
    video.evaluate((v) => {
      const m = v as HTMLVideoElement;
      return { paused: m.paused, muted: m.muted, time: m.currentTime };
    });
  await video.evaluate((v) => (v as HTMLVideoElement).pause());
  await expect.poll(async () => (await state()).paused).toBe(true);
  await page.locator("body").press("m");
  expect((await state()).muted).toBe(true);
  await expect(page.locator(".stage-notice")).toHaveText("Muted");
  await page.locator("body").press("k");
  await expect.poll(async () => (await state()).paused).toBe(false);
  await page.locator("body").press(" ");
  await expect.poll(async () => (await state()).paused).toBe(true);
  await video.evaluate((v) => ((v as HTMLVideoElement).currentTime = 1));
  await page.locator("body").press("ArrowRight");
  // The fixture is eight seconds long: a ten-second step stops at its end.
  await expect.poll(async () => (await state()).time).toBeGreaterThan(7);
  await page.locator("body").press("ArrowLeft");
  await expect.poll(async () => (await state()).time).toBeLessThan(1);
  // Typing in a control is never taken for a shortcut.
  await page.getByRole("button", { name: /Audio & subtitles/ }).click();
  await page
    .getByRole("group", { name: "Picture" })
    .getByRole("radio", { name: "720p HD", exact: true })
    .focus();
  await page.keyboard.press("m");
  expect((await state()).muted).toBe(true);
  await page.getByText("Keyboard shortcuts").click();
  await expect(page.getByText("Back or forward 10 seconds")).toBeVisible();
});

for (const width of [320, 360, 768, 1024, 1920, 2560, 3840]) {
  test(`every screen fits at ${width}px with readable type and reachable controls`, async ({
    page,
  }) => {
    await cinema(page, async (route, path) => {
      if (path !== "/api/playback") return;
      await route.fulfill({
        status: 202,
        json: {
          kind: "preparing",
          jobId: "job",
          progress: 12,
          phase: "repackaging",
          reason: "Repackaging your film without changing picture quality.",
        },
      });
      return true;
    });
    await page.setViewportSize({
      width,
      height: Math.round(Math.max(600, Math.min(width * 0.5625, 2160))),
    });
    for (const hash of [
      "#/library",
      "#/movie/film-3",
      "#/settings",
      "#/player/film-3",
      "#/watchlist",
    ]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("main h1, main h2").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await noOverflow(page), `${hash} overflows`).toBe(true);
      const problems = await page.evaluate(() => {
        const found: string[] = [];
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.visibility !== "hidden" &&
            !el.closest('[aria-hidden="true"], .sr-only, .skip-link')
          );
        };
        // WCAG 2.2 target size (minimum): 24 by 24 CSS pixels.
        for (const el of document.querySelectorAll(
          "a[href], button, input, select, textarea, summary",
        )) {
          if (!visible(el)) continue;
          // Links inside a sentence are exempt, as the criterion allows.
          if (
            el.matches("a, .text-link") &&
            getComputedStyle(el).display === "inline"
          )
            continue;
          let r = el.getBoundingClientRect();
          // A stretched link is measured by the area it actually covers.
          const after = getComputedStyle(el, ":after");
          if (after.position === "absolute" && after.content !== "none")
            r = (el.closest(".movie-card") ?? el).getBoundingClientRect();
          if (
            el.matches('input[type="checkbox"]') &&
            el.closest("label") !== null
          )
            r = el.closest("label")!.getBoundingClientRect();
          if (r.width < 24 || r.height < 24)
            found.push(
              `small target ${el.tagName} "${(el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
            );
        }
        const walker = document.createTreeWalker(
          document.querySelector("#root")!,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!node.textContent?.trim() || !parent || !visible(parent))
            continue;
          const size = parseFloat(getComputedStyle(parent).fontSize);
          if (size < 10)
            found.push(
              `small type ${size}px "${node.textContent.trim().slice(0, 24)}"`,
            );
        }
        return found;
      });
      expect(problems, `${hash} at ${width}px`).toEqual([]);
    }
  });
}

test("TV shows placeholders, then films, and the server's preparation steps", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/79.0 Safari/537.36",
  });
  const page = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await cinema(page, async (route, path) => {
    if (path === "/api/movies") {
      await held;
      return;
    }
    if (path === "/api/playback") {
      await route.fulfill({
        status: 202,
        json: {
          kind: "preparing",
          jobId: "job",
          progress: 44,
          phase: "converting",
          reason: "Creating a compatible edition.",
        },
      });
      return true;
    }
    return;
  });
  await page.goto("http://127.0.0.1:5174/");
  await expect(page.locator(".tv-sk-poster")).toHaveCount(6);
  release();
  const first = page.locator('[data-focus-id="movie-film-0"]');
  await expect(first).toBeFocused();
  await expect(page.locator(".tv-sk-poster")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-focus-id="watch"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Getting your film ready" }),
  ).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "44");
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "Convert for this screen",
  );
  // Close is the only control, and it has the focus.
  await expect(page.locator('[data-focus-id="close"]')).toBeFocused();
  expect(await noOverflow(page)).toBe(true);
  if (test.info().project.name === "chromium")
    await page.screenshot({
      path: "docs/testing/screenshots/tv-preparing.png",
    });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-focus-id="watch"]')).toBeFocused();
  await context.close();
});
