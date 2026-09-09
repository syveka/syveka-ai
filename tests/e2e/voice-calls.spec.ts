import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Zero prior coverage of the voice calls dashboard existed. No real phone
 * call is placed — this only proves the route, permission gate, and
 * rendering work. The E2E fixture org has no seeded VoiceCall rows today
 * (scripts/ensure-e2e-org-fixture.ts creates none), so the empty state is
 * the expected outcome; the non-empty branch is kept as a guard rather than
 * an assumption, so this doesn't become a flaky test if that ever changes.
 */
test.describe("voice calls", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("calls dashboard loads without error and renders a valid state", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/voice/calls");
    await expect(page.getByRole("heading", { name: "Puheluloki" })).toBeVisible();

    const emptyState = page.getByText("Ei puheluita vielä.");
    const callRows = page.locator('a[href*="/voice/calls/"]');
    await expect(emptyState.or(callRows.first())).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
