import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Business DNA had zero e2e coverage before this spec (see
 * docs/skills/AI-FOUNDATION-AUDIT.md §3 "Browser QA") despite a real staging
 * crash report on this exact route (fix/business-dna-onboarding-crash).
 * These tests exercise the authenticated page load and the profile save
 * flow the crash-fix branch's render tests could not cover (those mount
 * components in isolation; this drives the real route end-to-end).
 *
 * Text assertions below are hardcoded Finnish ("Tallenna", "Tallennettu.",
 * "Yrityksen DNA") rather than the bilingual regex pattern smoke.spec.ts
 * uses elsewhere — intentional, not an oversight: every `page.goto()` here
 * targets the unprefixed path, which next-intl's `localePrefix: "as-needed"`
 * routing always renders in Finnish (the default locale), regardless of the
 * browser's `locale: "fi-FI"` config (which only sets `Accept-Language`/
 * `navigator.language`, not which app locale is served).
 */
test.describe("business dna", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("page loads without a client-side exception", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/settings/business-dna");
    await expect(page.locator("h1")).toBeVisible();
    // A short, bounded settle window so a client exception thrown slightly
    // after the initial paint (e.g. from a useEffect that runs post-mount,
    // which is exactly the class of bug this spec exists to catch) isn't
    // missed by checking pageErrors immediately after the first visible
    // element appears.
    await page.waitForTimeout(500);

    expect(pageErrors, `unexpected client-side exception(s): ${pageErrors.join("; ")}`).toEqual([]);
  });

  /**
   * This test mutates the shared E2E organization's real Business DNA row
   * (`#displayName`), unlike the read-only tests above. Restricted to a
   * single project (desktop) rather than running on both desktop and
   * mobile: the same E2E account's Business DNA record is shared across
   * every project, so running this on both would race two concurrent
   * edit/save cycles against the same row (Playwright runs projects with
   * overlapping workers by default — nothing in playwright.config.ts
   * serializes them). Running it once is also sufficient to prove the save
   * round-trip works; the read-only tests already cover both projects for
   * page-load/render correctness.
   *
   * The original value is captured, changed to a deterministic temporary
   * value, saved, and restored in a `finally` block so restoration is
   * attempted even if the primary assertion fails above it — leaving the
   * shared staging organization's Business DNA permanently mutated would
   * pollute every subsequent run (CI or human) against the same account.
   * This is deliberately not timestamp-based cleanup (a later run would
   * have no way to know which timestamped value was "the real one" to put
   * back) — it round-trips through the actual original value instead.
   */
  test("company identity fields are editable and saving shows confirmation, then the original value is restored", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Mutates the shared E2E organization's Business DNA row — runs once (desktop) to avoid a desktop/mobile race on the same record.",
    );

    await page.goto("/settings/business-dna");
    const displayName = page.locator("#displayName");
    await expect(displayName).toBeVisible();

    const originalValue = await displayName.inputValue();
    const temporaryValue = `E2E-temp-${Date.now()}`;

    try {
      await displayName.fill(temporaryValue);
      await page.getByRole("button", { name: "Tallenna" }).click();
      await expect(page.getByText("Tallennettu.")).toBeVisible({ timeout: 10_000 });
    } finally {
      await displayName.fill(originalValue);
      await page.getByRole("button", { name: "Tallenna" }).click();
      await expect(page.getByText("Tallennettu.")).toBeVisible({ timeout: 10_000 });
    }
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
    await page.waitForTimeout(500); // see the settle-window comment above

    expect(pageErrors).toEqual([]);
  });
});
