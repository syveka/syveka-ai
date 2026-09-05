import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * smoke.spec.ts's RTL check only covers the unauthenticated public landing
 * page. Authenticated routes are a distinct render path (app shell, sidebar,
 * topbar all mount) and locale isn't switched anywhere else in the
 * authenticated suite, so this is the only place `dir="rtl"` and Arabic text
 * are proven for a logged-in user.
 */
test.describe("i18n: authenticated Arabic/RTL", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("an authenticated page renders Arabic with RTL direction", async ({ page }) => {
    await page.goto("/ar/crm/contacts");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("heading", { name: "جهات الاتصال" })).toBeVisible();
  });
});
