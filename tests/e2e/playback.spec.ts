import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("plays, seeks and closes a synthetic original with resume updates", async ({
  page,
}) => {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  const progress: number[] = [];
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (path === "/api/movies/fixture")
      body = {
        id: "fixture",
        title: "Synthetic playback fixture",
        resumeMs: 1000,
        available: true,
        description: "Test",
        saved: false,
        editions: [],
        tracks: [],
      };
    else if (path === "/api/playback")
      body = {
        kind: "ready",
        session: {
          id: "session",
          epoch: 1,
          mediaUrl: "/media/s/test/raw",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          startMs: 1000,
        },
      };
    else if (path === "/api/progress") {
      progress.push(route.request().postDataJSON().positionMs);
      body = { status: "accepted" };
    } else if (
      path === "/api/playback/session" &&
      route.request().method() === "DELETE"
    ) {
      stopped = true;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/media/s/test/raw", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/mp4",
      body: bytes,
      headers: { "accept-ranges": "bytes" },
    }),
  );
  await page.goto("/#/player/fixture");
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate(async (v) => {
    const media = v as HTMLVideoElement;
    await media.play();
  });
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1);
  await video.evaluate((v) => {
    const media = v as HTMLVideoElement;
    media.currentTime = 4;
    media.pause();
  });
  await expect.poll(() => progress.some((p) => p >= 3900)).toBe(true);
  await page.getByRole("link", { name: "Close player" }).click();
  await expect.poll(() => stopped).toBe(true);
  await expect(video).toHaveCount(0);
});
test("prepares automatically, loads captions and switches quality with resume", async ({
  page,
}) => {
  const bytes = await readFile(".local/test-media/synthetic.mp4");
  const requests: Array<{
    quality: string;
    audioTrack?: number;
    startMs: number;
  }> = [];
  let polls = 0,
    details = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/session")
      body = { authenticated: true, configured: true, csrfToken: "test" };
    else if (path === "/api/movies/fixture")
      body = {
        id: "fixture",
        title: "Prepared fixture",
        resumeMs: 1000,
        available: true,
        description: "",
        saved: false,
        editions: [],
        tracks: [],
        audioTracks:
          details++ === 0
            ? []
            : [
                { index: 0, label: "English" },
                { index: 1, label: "Persian" },
              ],
      };
    else if (path === "/api/playback") {
      const request = route.request().postDataJSON();
      requests.push(request);
      if (polls++ === 0)
        body = {
          kind: "preparing",
          jobId: "encode",
          progress: 42,
          reason: "Creating a compatible edition.",
        };
      else
        body = {
          kind: "ready",
          session: {
            id: "session",
            epoch: polls,
            mediaUrl: "/media/s/test/video.mp4",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            startMs: request.startMs,
            label: "720p · H.264",
            subtitles: [
              {
                url: "/media/s/test/subtitle-0.vtt",
                language: "fa",
                label: "Persian",
              },
            ],
          },
        };
    } else if (path === "/api/progress") body = { status: "accepted" };
    else if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/media/s/test/video.mp4", async (route) => {
    const range = route
      .request()
      .headers()
      ["range"]?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Number(range[2]) : bytes.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/mp4",
      body: bytes.subarray(start, end + 1),
      headers: {
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
    });
  });
  await page.route("**/media/s/test/subtitle-0.vtt", (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:07.000\nسلام\n",
    }),
  );
  await page.goto("/#/player/fixture");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "42");
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 10000 });
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await expect(video.locator("track")).toHaveAttribute("label", "Persian");
  await video.evaluate((v) => {
    const m = v as HTMLVideoElement;
    m.pause();
    m.currentTime = 3;
  });
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThanOrEqual(2.9);
  await page
    .getByRole("combobox", { name: "Playback quality" })
    .selectOption("720p");
  await expect.poll(() => requests.at(-1)?.quality).toBe("720p");
  expect(requests.at(-1)?.startMs).toBeGreaterThanOrEqual(2900);
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await page
    .getByRole("combobox", { name: "Audio track", exact: true })
    .selectOption("1");
  await expect.poll(() => requests.at(-1)?.audioTrack).toBe(1);
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
});
