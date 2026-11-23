import { test, expect, type Page } from "@playwright/test";
import { Secret, TOTP } from "otpauth";

// Synthetic browser fixtures only. Real security enforcement is covered by API tests.
const seed = "JBSWY3DPEHPK3PXP";
async function pending(
  page: Page,
  mode: "enroll" | "verify",
  expiry = Date.now() + 600000,
) {
  await page.route("**/api/session", (r) =>
    r.fulfill({
      json: {
        authenticated: false,
        configured: true,
        mfa: mode,
        csrfToken: "browser-test-only",
        challengeExpiresAt: expiry,
      },
    }),
  );
  await page.route("**/auth/mfa/enroll", (r) =>
    r.fulfill({
      json: {
        secret: seed,
        uri: new TOTP({
          issuer: "RAVAN",
          label: "TEST ONLY",
          secret: Secret.fromBase32(seed),
        }).toString(),
      },
    }),
  );
}
test("login layout and Google action work at desktop and narrow widths", async ({
  page,
}) => {
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { authenticated: false, configured: true } }),
  );
  await page.goto("/");
  const action = page.getByRole("link", { name: "Continue with Google" });
  await expect(action).toHaveAttribute("href", "/auth/google/start");
  await expect(
    page.getByRole("heading", { name: "Your cinema. Only yours." }),
  ).toBeVisible();
  for (const width of [1488, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(action).toBeVisible();
    if (
      test.info().project.name === "chromium" &&
      [1488, 390].includes(width)
    ) {
      await page.screenshot({
        path: `docs/testing/screenshots/login-${width}.png`,
        fullPage: true,
      });
    }
  }
});
test("website pairing returns to the approval screen after Google and MFA", async ({
  page,
}) => {
  let googleComplete = false;
  await page.route("**/api/session", (r) =>
    r.fulfill({
      json: googleComplete
        ? {
            authenticated: false,
            configured: true,
            mfa: "verify",
            csrfToken: "fixture",
            challengeExpiresAt: Date.now() + 600000,
          }
        : { authenticated: false, configured: true },
    }),
  );
  await page.route("**/auth/google/start", (r) => {
    googleComplete = true;
    return r.fulfill({
      contentType: "text/html",
      body: '<meta http-equiv="refresh" content="0;url=/">',
    });
  });
  await page.route("**/auth/mfa/verify", (r) =>
    r.fulfill({ json: { authenticated: true } }),
  );
  await page.goto("/#/settings");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify & enter" }).click();
  await expect(page).toHaveURL(/\/#\/settings$/);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("ravan:sign-in-destination"),
    ),
  ).toBeNull();
});
test("enrollment renders local QR, validates input and holds recovery codes until saved", async ({
  page,
}) => {
  await pending(page, "enroll");
  let sent: unknown;
  const codes = Array.from(
    { length: 8 },
    (_, i) => `00000000-00000000-00000000-${String(i).padStart(8, "0")}`,
  );
  await page.route("**/auth/mfa/verify", async (r) => {
    sent = r.request().postDataJSON();
    expect(r.request().headers()["x-csrf-token"]).toBe("browser-test-only");
    await r.fulfill({ json: { authenticated: true, recoveryCodes: codes } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("img", {
      name: "Scan this QR code with your authenticator app",
    }),
  ).toHaveAttribute("src", /^data:image\/png/);
  if (test.info().project.name === "chromium") {
    await page.screenshot({
      path: "docs/testing/screenshots/mfa-enrollment-1280.png",
      fullPage: true,
    });
  }
  await page.getByText("Can’t scan? Use the setup key").click();
  await expect(page.locator(".mfa-secret")).toHaveText(seed);
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Confirm authenticator" }).click();
  expect(sent).toEqual({ code: "123456", recovery: false });
  await expect(
    page.getByRole("heading", { name: "Keep a way back in." }),
  ).toBeVisible();
  await expect(page.locator(".recovery-codes li")).toHaveCount(8);
  await expect(
    page.getByRole("button", { name: "Enter your cinema" }),
  ).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery codes" }).click();
  expect((await download).suggestedFilename()).toBe("ravan-recovery-codes.txt");
  await page.getByLabel("I’ve saved my recovery codes.").check();
  await expect(
    page.getByRole("button", { name: "Enter your cinema" }),
  ).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    seed,
  );
});
test("verification shows errors, accepts paste, and recovery requires a new authenticator", async ({
  page,
}) => {
  await pending(page, "verify");
  await page.route("**/auth/mfa/verify", (r) =>
    r.request().postDataJSON().recovery
      ? r.fulfill({ json: { recoveryRequired: true } })
      : r.fulfill({ status: 400, json: { error: "mfa_invalid" } }),
  );
  await page.goto("/");
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify & enter" }).click();
  await expect(page.getByRole("alert")).toContainText("already used");
  await expect(page.getByLabel("Authenticator code")).toHaveValue("");
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page
    .getByLabel("Recovery code", { exact: true })
    .fill("00000000-00000000-00000000-00000000");
  await page.getByRole("button", { name: "Continue recovery" }).click();
  await expect(
    page.getByRole("heading", { name: "Make it just yours." }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Scan this QR code with your authenticator app",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
});
test("expired challenge clears enrollment and disables verification", async ({
  page,
}) => {
  await pending(page, "enroll", Date.now() - 1);
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("expired");
  await expect(
    page.getByRole("button", { name: "Confirm authenticator" }),
  ).toBeDisabled();
  await expect(page.locator(".mfa-secret")).toHaveCount(0);
});
test("mobile MFA is readable and server errors remain recoverable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await pending(page, "verify");
  await page.route("**/auth/mfa/verify", (r) =>
    r.fulfill({ status: 429, json: { error: "mfa_locked" } }),
  );
  await page.goto("/");
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify & enter" }).click();
  await expect(page.getByRole("alert")).toContainText("Wait 15 minutes");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole("button", { name: "Start again" })).toBeVisible();
});
