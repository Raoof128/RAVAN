import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

/** A signed-in cinema whose film plays the given edition. */
async function cinema(
  page: Page,
  options: {
    mediaUrl: string;
    subtitleLanguage?: string;
    subtitles?: Array<{ url: string; language: string; label: string }>;
    detail?: object;
    pictures?: Array<{ quality: string; state: string; films?: number }>;
  },
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (path === "/api/movies/fixture")
      body = {
        id: "fixture",
        title: "Two languages",
        resumeMs: 0,
        available: true,
        description: "",
        saved: false,
        editions: [],
        tracks: [],
        audioTracks: [
          { index: 0, language: "eng", label: "English" },
          { index: 1, language: "fas", label: "Persian · 5.1" },
        ],
        ...options.detail,
      };
    else if (path === "/api/movies/fixture/pictures")
      body = { items: options.pictures ?? [] };
    else if (path === "/api/preferences")
      body = {
        audioLanguage: "original",
        subtitleLanguage: options.subtitleLanguage ?? "off",
        quality: "original",
        reducedMotion: false,
      };
    else if (path === "/api/playback")
      body = {
        kind: "ready",
        session: {
          id: "session",
          epoch: 1,
          mediaUrl: options.mediaUrl,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          startMs: 0,
          subtitles: options.subtitles ?? [],
        },
      };
    else if (path === "/api/progress") body = { status: "accepted" };
    await route.fulfill({ json: body });
  });
}
/** The audio and subtitles panel, opened. */
async function openTracks(page: Page) {
  const panel = page.getByRole("dialog", {
    name: "Audio, subtitles and picture",
  });
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: /Audio & subtitles/ }).click();
  await expect(panel).toBeVisible();
  return panel;
}
const choice = (page: Page, group: string, name: string) =>
  page
    .getByRole("dialog", { name: "Audio, subtitles and picture" })
    .getByRole("group", { name: group })
    .getByRole("radio", { name, exact: true });
const choices = (page: Page, group: string) =>
  page
    .getByRole("dialog", { name: "Audio, subtitles and picture" })
    .getByRole("group", { name: group })
    .locator(".track-name");
const ready = (page: Page) =>
  expect
    .poll(() =>
      page.locator("video").evaluate((v) => (v as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);

test("changes language at once in an edition that carries every track", async ({
  page,
}) => {
  const requests: string[] = [];
  await cinema(page, { mediaUrl: "/media/s/test/index.m3u8" });
  await page.route("**/media/s/test/**", async (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop()!;
    requests.push(file);
    await route.fulfill({
      contentType: file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : file.endsWith("init.mp4")
          ? "video/mp4"
          : "video/iso.segment",
      body: await readFile(`.local/test-media/hls-multi/${file}`),
    });
  });
  let playbackRequests = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/playback") playbackRequests++;
  });
  await page.goto("/#/player/fixture");
  await ready(page);
  const panel = await openTracks(page);
  // The names are the film's page's own; the channel layout is shown beside.
  await expect(choices(page, "Audio")).toHaveText(["English", "Persian"]);
  await expect(choice(page, "Audio", "Persian 5.1")).toBeVisible();
  await expect(choice(page, "Audio", "English")).toBeChecked();
  // No note about preparing again: this edition switches in place.
  await expect(panel.getByText("prepares the film again")).toHaveCount(0);
  await choice(page, "Audio", "Persian 5.1").check();
  await expect(choice(page, "Audio", "Persian 5.1")).toBeChecked();
  // The button says what is playing.
  await expect(
    page.getByRole("button", { name: /Audio & subtitles/ }),
  ).toContainText("Persian");
  // The second language's own stream is fetched; the film is not asked for again.
  await expect.poll(() => requests.some((f) => f.startsWith("a1-"))).toBe(true);
  expect(playbackRequests).toBe(1);
  await page.locator("video").evaluate(async (v) => {
    const media = v as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((v) => (v as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(1);
});

test("shows subtitles in the saved language, lets the viewer turn them off, and says why picture subtitles are missing", async ({
  page,
}) => {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  await cinema(page, {
    mediaUrl: "/media/s/test/video.mp4",
    subtitleLanguage: "fa",
    subtitles: [
      {
        url: "/media/s/test/subtitle-0.vtt",
        language: "eng",
        label: "English",
      },
      {
        url: "/media/s/test/subtitle-1.vtt",
        language: "fas",
        label: "Persian",
      },
    ],
    detail: {
      audioTracks: [],
      subtitleTracks: [
        { language: "eng", label: "English", text: true },
        { language: "fas", label: "Persian", text: true },
        { language: "fra", label: "French", text: false },
      ],
    },
  });
  await page.route("**/media/s/test/video.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: bytes }),
  );
  await page.route("**/media/s/test/subtitle-*.vtt", (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:07.000\nسلام\n",
    }),
  );
  await page.goto("/#/player/fixture");
  await ready(page);
  await openTracks(page);
  // The saved preference is "fa"; the track says "fas". Both are Persian.
  await expect(choice(page, "Subtitles", "Persian")).toBeChecked();
  await expect(
    choice(page, "Subtitles", "French picture, can’t be shown"),
  ).toBeDisabled();
  const showing = () =>
    page.locator("video").evaluate((v) =>
      Array.from((v as HTMLVideoElement).textTracks)
        .filter((t) => t.mode === "showing")
        .map((t) => t.label),
    );
  expect(await showing()).toEqual(["Persian"]);
  await choice(page, "Subtitles", "Off").check();
  await expect.poll(showing).toEqual([]);
  await choice(page, "Subtitles", "English").check();
  await expect.poll(showing).toEqual(["English"]);
  // Escape closes the panel and hands focus back to its button.
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Audio, subtitles and picture" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Audio & subtitles/ }),
  ).toBeFocused();
  // C goes on to the next track, then off. Shortcuts wait while a button
  // has focus, so the viewer first returns to the picture.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.locator("body").press("c");
  await expect.poll(showing).toEqual(["Persian"]);
  await page.locator("body").press("c");
  await expect.poll(showing).toEqual([]);
  await expect(page.locator(".stage-notice")).toHaveText("Subtitles off");
});

test("keeps the language the viewer picks, after a one-language edition led to an all-languages one", async ({
  page,
}) => {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  let calls = 0;
  await cinema(page, { mediaUrl: "" });
  // First a one-language edition; asking for Persian gives the all-languages one.
  await page.route("**/api/playback", async (route) => {
    calls++;
    await route.fulfill({
      json: {
        kind: "ready",
        session: {
          id: `s${calls}`,
          epoch: calls,
          mediaUrl:
            calls === 1
              ? "/media/s/test/video.mp4"
              : "/media/s/test/index.m3u8",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          startMs: 0,
          subtitles: [],
        },
      },
    });
  });
  await page.route("**/media/s/test/**", async (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop()!;
    if (file === "video.mp4")
      return route.fulfill({ contentType: "video/mp4", body: bytes });
    await route.fulfill({
      contentType: file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp4",
      body: await readFile(`.local/test-media/hls-multi/${file}`),
    });
  });
  await page.goto("/#/player/fixture");
  await ready(page);
  await openTracks(page);
  // This copy has one language: the panel says choosing another prepares it.
  await expect(
    page
      .getByRole("dialog", { name: "Audio, subtitles and picture" })
      .getByText("prepares the film again"),
  ).toBeVisible();
  await choice(page, "Audio", "Persian 5.1").check();
  await expect.poll(() => calls).toBe(2);
  await ready(page);
  // The stream now offers both; the one asked for is playing.
  await openTracks(page);
  await expect(choices(page, "Audio")).toHaveCount(2);
  await expect(choice(page, "Audio", "Persian 5.1")).toBeChecked();
  // The viewer goes back to English, and it stays English.
  await choice(page, "Audio", "English").check();
  await expect(choice(page, "Audio", "English")).toBeChecked();
  await page.waitForTimeout(1500);
  await expect(choice(page, "Audio", "English")).toBeChecked();
  expect(calls).toBe(2);
});

test("shows the audio menu for a film with one language, and keeps the menus in full screen", async ({
  page,
  browserName,
}) => {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  await cinema(page, {
    mediaUrl: "/media/s/test/video.mp4",
    detail: {
      audioTracks: [{ index: 0, language: "eng", label: "English · 5.1" }],
    },
  });
  await page.route("**/media/s/test/video.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: bytes }),
  );
  await page.goto("/#/player/fixture");
  await ready(page);
  // Nothing to choose: the one language is shown as chosen, and said to be the only one.
  const panel = await openTracks(page);
  await expect(choices(page, "Audio")).toHaveText(["English"]);
  await expect(choice(page, "Audio", "English 5.1")).toBeChecked();
  await expect(
    panel.getByText("The only language in this film."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // The browser's own full-screen button is hidden; ours takes the menus along.
  await expect(page.locator("video")).toHaveAttribute(
    "controlslist",
    "nofullscreen",
  );
  if (browserName !== "chromium") return;
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement?.className ?? ""),
    )
    .toContain("player-frame");
  await expect(
    page.getByRole("button", { name: /Audio & subtitles/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
});

test("says before choosing what each picture would do to the other prepared films", async ({
  page,
}) => {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  await cinema(page, {
    mediaUrl: "/media/s/test/video.mp4",
    pictures: [
      { quality: "auto", state: "ready" },
      { quality: "480p", state: "ready" },
      { quality: "720p", state: "fits" },
      { quality: "1440p", state: "too-large" },
      { quality: "2160p", state: "removes", films: 2 },
    ],
  });
  await page.route("**/media/s/test/video.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: bytes }),
  );
  await page.goto("/#/player/fixture");
  await ready(page);
  const panel = await openTracks(page);
  await expect(
    choice(page, "Picture", "2160p 4K removes 2 prepared films"),
  ).toBeEnabled();
  await expect(
    choice(page, "Picture", "480p saves data, ready to play"),
  ).toBeVisible();
  await expect(choice(page, "Picture", "720p HD")).toBeVisible();
  await expect(
    choice(page, "Picture", "1440p no room while other films play"),
  ).toBeDisabled();
  await expect(
    panel.getByText(
      "removing the prepared copies of the films least recently watched",
    ),
  ).toBeVisible();
});
