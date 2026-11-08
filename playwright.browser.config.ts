import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of real UI components in Chromium, with no deployed app, no
 * database and no network: each test serves a bundled harness page and
 * answers the page's API requests itself (see tests/browser/). Separate from
 * playwright.config.ts, whose E2E suite needs a deployed environment and
 * real accounts.
 *
 *   npm run test:browser
 */
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30_000,
  retries: 0,
  use: {
    trace: "off",
    // An unreachable origin: requests are fulfilled by the test or aborted.
    baseURL: "http://booking.test",
    // Optional: a preinstalled Chromium whose build differs from this
    // Playwright version's (otherwise `npx playwright install chromium`).
    launchOptions: process.env.PW_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
