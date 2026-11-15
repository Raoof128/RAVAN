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
  const audio = page.getByRole("combobox", { name: "Audio track" });
  // The names are the film's page's own, with the channel layout.
  await expect(audio.locator("option")).toHaveText([
    "English",
    "Persian · 5.1",
  ]);
  await expect(audio).toHaveValue("0");
  // No note about preparing again: this edition switches in place.
  await expect(page.locator("#audio-note")).toHaveCount(0);
  await audio.selectOption("1");
  await expect(audio).toHaveValue("1");
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
  const menu = page.getByRole("combobox", { name: "Subtitles" });
  // The saved preference is "fa"; the track says "fas". Both are Persian.
  await expect(menu).toHaveValue("1");
  await expect(menu.locator("option:checked")).toHaveText("Persian");
  await expect(
    menu.locator("option", { hasText: "French (picture subtitles" }),
  ).toBeDisabled();
  const showing = () =>
    page.locator("video").evaluate((v) =>
      Array.from((v as HTMLVideoElement).textTracks)
        .filter((t) => t.mode === "showing")
        .map((t) => t.label),
    );
  expect(await showing()).toEqual(["Persian"]);
  await menu.selectOption("");
  await expect.poll(showing).toEqual([]);
  await menu.selectOption("0");
  await expect.poll(showing).toEqual(["English"]);
  // C goes on to the next track, then off.
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
  const audio = page.getByRole("combobox", { name: "Audio track" });
  await audio.selectOption("1");
  await expect.poll(() => calls).toBe(2);
  await ready(page);
  // The stream now offers both; the one asked for is playing.
  await expect(audio.locator("option")).toHaveCount(2);
  await expect(audio).toHaveValue("1");
  // The viewer goes back to English, and it stays English.
  await audio.selectOption("0");
  await expect(audio).toHaveValue("0");
  await page.waitForTimeout(1500);
  await expect(audio).toHaveValue("0");
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
  const audio = page.getByRole("combobox", { name: "Audio track" });
  await expect(audio).toBeVisible();
  await expect(audio).toBeDisabled();
  await expect(audio.locator("option")).toHaveText(["English · 5.1"]);
  await expect(page.locator("#audio-note")).toContainText("one language");
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
  await expect(audio).toBeVisible();
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
});
