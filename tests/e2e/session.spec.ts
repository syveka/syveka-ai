import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Zero prior coverage of logout existed: every authenticated spec relies on
 * the storageState session staying valid, but nothing proved the session
 * actually ends when a user asks it to, or that the app doesn't leave a
 * stale authenticated view reachable after signing out.
 */
test.describe("session", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("logout ends the session and re-protects the dashboard", async ({ page }) => {
    await page.getByRole("button", { name: "logout" }).click();
    await expect(page).toHaveURL(/\/login/);

    // The storageState this test started with must no longer grant access —
    // otherwise logout only redirected the UI without ending the session.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
