import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.RAVAN_BASE_URL ?? "http://127.0.0.1:8787";
export default defineConfig({
  testDir: "tests/release",
  fullyParallel: true,
  workers: 3,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: process.env.RAVAN_BASE_URL
    ? undefined
    : {
        command: "npx --yes wrangler@4.162.0 dev --ip 127.0.0.1 --port 8787",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60000,
      },
});
