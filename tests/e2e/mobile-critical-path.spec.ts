import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * The sidebar nav (src/components/layout/app-sidebar.tsx) is
 * `hidden ... md:block` — deliberately absent below the `md` breakpoint, with
 * no mobile replacement (no drawer/hamburger/bottom nav exists anywhere in
 * the layout). That's a real product gap (see the readiness report), not
 * something to invent a UI for in this PR. This spec instead asserts the
 * actual current mobile contract stays true: the dashboard itself renders
 * correctly, the sidebar correctly stays hidden (a regression here would
 * mean it started overlapping content), and the topbar — the only nav a
 * mobile user has today (locale, theme, notifications, logout) — still
 * works.
 */
test.describe("mobile critical path", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("dashboard renders on a mobile viewport with the topbar usable and no desktop sidebar overlap", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile-viewport-specific check.");

    await expect(page.getByText(/avoimet kaupat|open deals/i)).toBeVisible();
    await expect(page.locator("aside")).toBeHidden();
    await expect(page.getByRole("button", { name: "logout" })).toBeVisible();
    await expect(page.getByRole("button", { name: "notifications" })).toBeVisible();
  });
});
