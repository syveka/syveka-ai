import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Zero prior coverage of billing existed. This only reads state the E2E
 * fixture org already has (a seeded FREE/ACTIVE subscription — see
 * scripts/ensure-e2e-org-fixture.ts) — it never clicks "choose plan"/opens
 * the Stripe portal, since either would start a real Stripe Checkout/portal
 * session.
 */
test.describe("billing", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("billing page shows the current plan and usage, without starting a Stripe session", async ({
    page,
  }) => {
    await page.goto("/settings/billing");

    await expect(page.getByText("Nykyinen tilaus").first()).toBeVisible();
    await expect(page.getByText("FREE")).toBeVisible();

    // FREE-plan orgs have no portal link (only paid plans do) — the OWNER
    // fixture user can manage billing, so the upgrade cards must render.
    await expect(page.getByRole("button", { name: "Hallinnoi Stripe-portaalissa" })).toHaveCount(0);
    const choosePlanButtons = page.getByRole("button", { name: "Valitse tilaus" });
    await expect(choosePlanButtons.first()).toBeVisible();
  });
});
