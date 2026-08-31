import { test, expect } from "@playwright/test";
import { loginAsE2EUser, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Business DNA had zero e2e coverage before this spec (see
 * docs/skills/AI-FOUNDATION-AUDIT.md §3 "Browser QA") despite a real staging
 * crash report on this exact route (fix/business-dna-onboarding-crash).
 * These tests exercise the authenticated page load and the profile save
 * flow the crash-fix branch's render tests could not cover (those mount
 * components in isolation; this drives the real route end-to-end).
 */
test.describe("business dna", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await loginAsE2EUser(page);
  });

  test("page loads without a client-side exception", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/settings/business-dna");
    await expect(page.locator("h1")).toBeVisible();

    expect(pageErrors, `unexpected client-side exception(s): ${pageErrors.join("; ")}`).toEqual([]);
  });

  test("company identity fields are editable and saving shows confirmation", async ({ page }) => {
    await page.goto("/settings/business-dna");
    const displayName = page.locator("#displayName");
    await expect(displayName).toBeVisible();

    await displayName.fill(`E2E Test Business ${Date.now()}`);
    await page.getByRole("button", { name: "Tallenna" }).click();

    await expect(page.getByText("Tallennettu.")).toBeVisible({ timeout: 10_000 });
  });

  test("the regenerate-from-website client component mounts without throwing", async ({ page }) => {
    // RegenerateFromWebsite was one of the client components audited (and
    // cleared) during the fix/business-dna-onboarding-crash investigation —
    // this proves it actually mounts on the real route, not just in an
    // isolated render test.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/settings/business-dna");
    await expect(page.locator("#regenerate-url")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Yrityksen DNA" })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
