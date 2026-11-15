import { test, expect } from "@playwright/test";

test("production setup does not enable preview through a query parameter", async ({
  page,
}) => {
  await page.goto("/?preview=1");
  await expect(page).toHaveTitle("RAVAN — Every Story Flows.");
  await expect(
    page.getByRole("heading", { name: "Your cinema. Only yours." }),
  ).toBeVisible();
  await expect(page.getByText("DESIGN PREVIEW", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page
        .locator(".login-art img")
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await page.evaluate(() => document.fonts.ready);
  if (test.info().project.name === "chromium") {
    for (const width of [1488, 390]) {
      await page.setViewportSize({
        width,
        height: width === 1488 ? 1056 : 844,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `docs/testing/screenshots/login-production-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.getByRole("link", { name: "Explore the sample library" }).click();
  await expect(page.locator(".preview-banner")).toContainText("PUBLIC DEMO");
});

test("hosted demo loads artwork and search without reaching private APIs", async ({
  page,
}) => {
  const errors: string[] = [];
  const apiRequests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/"))
      apiRequests.push(r.url());
  });
  await page.goto("/demo/");
  await expect(
    page.getByRole("heading", { name: "The Quiet Coast", level: 1 }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".feature > img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole("searchbox").fill("night");
  await page.getByRole("link", { name: "View Night Transit" }).click();
  await expect(
    page.getByRole("heading", { name: "Night Transit", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "+ Watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In watchlist" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(apiRequests).toEqual([]);
});

test("mobile demo displays the hero without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/");
  await expect(
    page.getByRole("heading", { name: "The Quiet Coast", level: 1 }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("link", { name: "Continue watching", exact: true })
    .click();
  await expect(
    page.getByText("This is an interface preview.", { exact: false }),
  ).toBeVisible();
});

test("edge reports its deployment and fails closed for private routes", async ({
  request,
}) => {
  const index = await request.get("/");
  expect(index.status()).toBe(200);
  expect(index.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  // Markup that should never get in could not post a form to another host.
  expect(index.headers()["content-security-policy"]).toContain(
    "form-action 'self'",
  );
  expect(index.headers()["x-content-type-options"]).toBe("nosniff");
  const session = await request.get("/api/session?preview=1");
  expect(await session.json()).toEqual({
    authenticated: false,
    configured: false,
  });
  expect(session.headers()["cache-control"]).toBe("no-store");
  for (const path of ["/auth/google/start", "/api/movies"])
    expect((await request.get(path)).status()).toBe(503);
  for (const path of [
    "/media/s/fake/raw",
    "/_worker/source",
    "/.env",
    "/assets/missing.js",
  ])
    expect((await request.get(path)).status()).toBe(404);
  expect(
    (
      await request.post("/api/library", { data: { folderId: "example" } })
    ).status(),
  ).toBe(503);
  for (const path of [
    "/auth/mfa/enroll",
    "/auth/mfa/verify",
    "/auth/mfa/cancel",
  ]) {
    const response = await request.post(path, { data: { code: "123456" } });
    expect(response.status()).toBe(503);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  }
  const version = await (await request.get("/version.json")).json();
  expect(version.deployment).toBe("frontend");
  expect(version.streaming).toBe(false);
  if (process.env.RAVAN_EXPECTED_RELEASE)
    expect(version.release).toBe(process.env.RAVAN_EXPECTED_RELEASE);
});
