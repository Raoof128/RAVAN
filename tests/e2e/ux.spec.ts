import { test, expect, type Page } from "@playwright/test";

const titles = [
  "The Long Way Home",
  "Harbour Lights",
  "A Quiet Hour",
  "North of Summer",
  "Paper Moonlight",
  "The Last Reel",
];
const film = (i: number) => ({
  id: `film-${i}`,
  title: `${titles[i % titles.length]} ${Math.floor(i / titles.length) + 1}`,
  year: 1990 + i,
  resumeMs: i === 0 ? 1320000 : 0,
  available: true,
});
/** A signed-in cinema with forty films; counts how often the list was asked for. */
async function cinema(page: Page) {
  const calls = { lists: 0 };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (path === "/api/movies") {
      calls.lists++;
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      body = {
        items: Array.from({ length: 40 }, (_, i) => film(i)).filter((m) =>
          m.title.toLowerCase().includes(q),
        ),
        nextCursor: null,
      };
    } else if (path.startsWith("/api/movies/")) {
      const i = Number(path.split("-").pop());
      body = {
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
      };
    } else if (path === "/api/playback") {
      await route.fulfill({
        status: 422,
        json: {
          kind: "unsupported",
          reason: "This file could not be decoded.",
        },
      });
      return;
    } else if (path === "/api/library")
      body = {
        folderId: "folder",
        state: "succeeded",
        counts: { upserts: 40 },
      };
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
  return calls;
}
const hero = (page: Page) =>
  page.getByRole("heading", { name: "The Long Way Home 1", level: 1 });

test("returning from a film finds the list, the search and the place as they were left", async ({
  page,
}) => {
  const calls = await cinema(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(hero(page)).toBeVisible();
  // Far down the collection.
  const card = page.getByRole("link", { name: "View Paper Moonlight 6" });
  await card.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(1500);
  const asked = calls.lists;
  await card.click();
  await expect(
    page.getByRole("heading", { name: "Paper Moonlight 6", level: 1 }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The page's own link goes back rather than opening a second copy.
  await page.getByRole("link", { name: "Back to the collection" }).click();
  await expect(card).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(before - 80);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(before + 80);
  // Nothing was fetched again for it.
  expect(calls.lists).toBe(asked);

  // The same for a search, with the browser's own Back.
  await page.getByRole("searchbox").fill("harbour");
  await expect(
    page.getByRole("link", { name: "View Harbour Lights 3" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View Paper Moonlight 6" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "View Harbour Lights 3" }).click();
  await expect(
    page.getByRole("heading", { name: "Harbour Lights 3", level: 1 }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("searchbox")).toHaveValue("harbour");
  await expect(
    page.getByRole("heading", { name: "Search results", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View Harbour Lights 3" }),
  ).toBeVisible();

  // A link followed afresh still opens at the top.
  await page.getByRole("link", { name: "Your cinema", exact: true }).click();
  await expect(page.getByLabel("Drive folder ID")).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("a film opened directly still has a way back to the library", async ({
  page,
}) => {
  await cinema(page);
  await page.goto("/#/movie/film-3");
  await expect(
    page.getByRole("heading", { name: "North of Summer 1", level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to the collection" }).click();
  await expect(hero(page)).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/library");
});

test("slash reaches the search and Escape clears it", async ({ page }) => {
  await cinema(page);
  await page.goto("/");
  await expect(hero(page)).toBeVisible();
  await page.locator("body").press("/");
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();
  await search.pressSequentially("reel");
  await expect(search).toHaveValue("reel");
  await expect(
    page.getByRole("heading", { name: "Search results", level: 1 }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(hero(page)).toBeVisible();
  // A slash typed into a field is just a slash.
  await search.pressSequentially("a/b");
  await expect(search).toHaveValue("a/b");
});

test("on a phone, fields do not trigger zoom, targets fit a thumb and every screen has one heading", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await cinema(page);
  for (const hash of [
    "#/library",
    "#/watchlist",
    "#/movie/film-2",
    "#/settings",
    "#/player/film-2",
  ]) {
    await page.goto(`http://127.0.0.1:5173/${hash}`);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const found = await page.evaluate(() => {
      const problems: string[] = [];
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          getComputedStyle(el).visibility !== "hidden" &&
          !el.closest('[aria-hidden="true"], .sr-only, .skip-link')
        );
      };
      const headings = document.querySelectorAll("h1").length;
      if (headings !== 1) problems.push(`${headings} h1 elements`);
      for (const el of document.querySelectorAll(
        "a[href], button, input, select, textarea, summary",
      )) {
        if (!visible(el)) continue;
        if (
          el.matches("a, .text-link") &&
          getComputedStyle(el).display === "inline"
        )
          continue;
        let r = el.getBoundingClientRect();
        const after = getComputedStyle(el, ":after");
        if (after.position === "absolute" && after.content !== "none")
          r = (el.closest(".movie-card") ?? el).getBoundingClientRect();
        if (el.matches('input[type="checkbox"]') && el.closest("label"))
          r = el.closest("label")!.getBoundingClientRect();
        // 44 by 44 points: the size both Apple and Google ask for under a finger.
        if (r.width < 44 || r.height < 44)
          problems.push(
            `target ${el.tagName} "${(el.textContent ?? "").trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        if (
          el.matches("input:not([type=checkbox]), select, textarea") &&
          parseFloat(getComputedStyle(el).fontSize) < 16
        )
          problems.push(
            `field ${el.getAttribute("aria-label") ?? el.getAttribute("name")} ${getComputedStyle(el).fontSize}`,
          );
      }
      // Characters standing in for icons render differently on every device.
      if (/[▶↗⌕↻◌]/.test(document.querySelector("#root")!.textContent ?? ""))
        problems.push("a glyph is used as an icon");
      return problems;
    });
    expect(found, hash).toEqual([]);
  }
  await context.close();
});

test("losing the connection is said plainly, and unsaid when it returns", async ({
  page,
  context,
}) => {
  await cinema(page);
  await page.goto("/");
  await expect(hero(page)).toBeVisible();
  await expect(page.getByText("This device is offline.")).toHaveCount(0);
  await context.setOffline(true);
  await expect(
    page.getByText("This device is offline.", { exact: false }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    page.getByText("This device is offline.", { exact: false }),
  ).toHaveCount(0);
});

test("the task bar follows the current screen and leaves the picture clear", async ({
  page,
  browserName,
}) => {
  await cinema(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const bar = page.getByRole("navigation", { name: "Main navigation" });
  const library = bar.getByRole("link", { name: "Library" });
  const saved = bar.getByRole("link", { name: "Watchlist" });
  await expect(bar.getByRole("link")).toHaveCount(4);
  await expect(library).toHaveAttribute("aria-current", "page");
  await library.focus();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(saved).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(saved).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator(".movie-caption").first().getByRole("heading", { level: 2 }),
  ).toBeVisible();
  expect(
    await bar.evaluate(
      (el) => getComputedStyle(el, "::before").transitionDuration,
    ),
  ).toBe("0s");
  await page.setViewportSize({ width: 320, height: 680 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(saved).toBeInViewport();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe(
    "fixed",
  );
  await bar.getByRole("link", { name: "Your cinema" }).click();
  await expect(page.getByLabel("Device pairing code")).toBeVisible();
  await page.goto("/#/player/film-0");
  await expect(page.locator("main h1")).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe(
    "relative",
  );
});

test("a field explains what it needs in words, and removing a TV looks like what it is", async ({
  page,
}) => {
  await cinema(page);
  await page.goto("/#/settings");
  const folder = page.getByLabel("Drive folder ID");
  await folder.fill("not a folder!");
  await page.getByRole("button", { name: "Use this folder" }).click();
  expect(
    await folder.evaluate((el) => (el as HTMLInputElement).validationMessage),
  ).toContain("letters, numbers, hyphens and underscores");
  // Correcting the field clears the message.
  await folder.fill("1AbC_d-9");
  expect(
    await folder.evaluate((el) => (el as HTMLInputElement).validationMessage),
  ).toBe("");
  await page.getByRole("button", { name: "Remove Living room" }).click();
  const confirm = page.getByRole("button", { name: "Remove Living room" });
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveClass(/danger/);
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Living room" }),
  ).toBeFocused();
});

test("the owner explicitly grants watchlist and Reading Room access to each paired screen", async ({
  page,
  browserName,
}) => {
  await cinema(page);
  const approvals: unknown[] = [];
  let acknowledged = false;
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: approvals.length
        ? [
            {
              id: "phone",
              name: "Fixture iPhone",
              pairingState: acknowledged ? "paired" : "awaitingDevice",
            },
          ]
        : [],
    }),
  );
  await page.route("**/api/pairing/approve", async (route) => {
    approvals.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/#/settings");
  const code = page.getByLabel("Device pairing code");
  const permission = page.getByRole("checkbox", {
    name: "Allow this device to change the watchlist",
  });
  const reading = page.getByRole("checkbox", { name: /open the Reading Room/ });
  const approve = page.getByRole("button", { name: "Approve this device" });

  await expect(permission).not.toBeChecked();
  await expect(reading).not.toBeChecked();
  await code.focus();
  await code.pressSequentially("abcd efgh");
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await page.keyboard.press(tab);
  await expect(permission).toBeFocused();
  await page.keyboard.press(tab);
  await expect(reading).toBeFocused();
  await page.keyboard.press(tab);
  await expect(approve).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => approvals.length).toBe(1);
  expect(approvals[0]).toEqual({ code: "ABCDEFGH" });

  await expect(code).toHaveValue("");
  const phone = page
    .getByRole("listitem")
    .filter({ hasText: "Fixture iPhone" });
  await expect(phone.getByText("Waiting for device")).toBeVisible();
  await expect(phone.getByText("Paired", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Return to RAVĀN on your device/)).toBeVisible();
  acknowledged = true;
  await expect(phone.getByText("Paired", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(phone.getByText("Waiting for device")).toHaveCount(0);
  await code.fill("JKMN PQRS");
  await permission.check();
  await approve.click();
  await expect.poll(() => approvals.length).toBe(2);
  expect(approvals[1]).toEqual({ code: "JKMNPQRS", watchlistWrite: true });
  await expect(permission).not.toBeChecked();
  await code.fill("QRST UVWX");
  await reading.check();
  await approve.click();
  await expect.poll(() => approvals.length).toBe(3);
  expect(approvals[2]).toEqual({ code: "QRSTUVWX", reading: true });
  await expect(reading).not.toBeChecked();
});
