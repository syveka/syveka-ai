import { test, expect, type Page } from "@playwright/test";
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
/** Finnish UI strings (unprefixed paths render the default locale; see above). */
const FI = {
  save: "Tallenna",
  saved: "Tallennettu.",
  conflict: /muutettiin muualla/,
  conflictReload: "Lataa uusin versio (muutoksesi hylätään)",
};
const MUTATING_PROJECT_REASON =
  "Mutates the shared E2E organization's Business DNA row — runs once (desktop) to avoid a desktop/mobile race on the same record.";
const NO_PROFILE_REASON =
  "The E2E organization has no saved Business DNA profile; saving would create one, which this test can't undo.";

async function openBusinessDna(page: Page) {
  await page.goto("/settings/business-dna");
  await expect(page.locator("#displayName")).toBeVisible();
  // #displayName is server-rendered: wait until the page has hydrated, so
  // typing and Save go through React (a server action), not the no-JS form post.
  await page.waitForLoadState("networkidle");
}

/**
 * The profile form's own alerts. Scoped to the form because Next.js always
 * mounts a screen-reader-only role="alert" route announcer on the page (see
 * loginFormAlert in helpers/auth.ts).
 */
const formAlert = (page: Page) => page.locator("#business-dna-form").getByRole("alert");

/** The form carries the loaded profile's version; empty when there is no profile yet. */
async function hasSavedProfile(page: Page) {
  return (await page.locator('input[name="expectedUpdatedAt"]').inputValue()) !== "";
}

/**
 * Clicks Save and waits for that save's own server action response, so the
 * outcome checked afterwards is this save's (never a message left on screen
 * by an earlier one).
 */
async function save(page: Page) {
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.request().headers()["next-action"] !== undefined &&
      new URL(r.url()).pathname.endsWith("/settings/business-dna"),
    { timeout: 15_000 },
  );
  await page.getByRole("button", { name: FI.save }).click();
  await response;
  await expect(page.getByRole("button", { name: FI.save })).toBeEnabled();
}

async function expectSaved(page: Page) {
  await save(page);
  await expect(formAlert(page)).toHaveCount(0);
  await expect(page.getByText(FI.saved)).toBeVisible();
}

async function expectConflict(page: Page) {
  await save(page);
  await expect(formAlert(page)).toContainText(FI.conflict);
}

/** The persisted value, read from a freshly loaded page. */
async function freshValue(page: Page, selector: string) {
  await openBusinessDna(page);
  return page.locator(selector).inputValue();
}

/**
 * Puts the original value back from a freshly loaded form (the current
 * version): a change made meanwhile makes this conflict instead of being
 * overwritten, and the test then fails loudly.
 */
async function restoreValue(page: Page, selector: string, original: string) {
  await openBusinessDna(page);
  if ((await page.locator(selector).inputValue()) === original) return;
  await page.locator(selector).fill(original);
  await expectSaved(page);
  expect(await freshValue(page, selector)).toBe(original);
}

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
   * The two tests below mutate the shared E2E organization's real Business
   * DNA row, unlike the read-only tests around them, so they:
   * - run once (desktop project only): the same account's row is shared by
   *   every project, and running on both would race two edit/save cycles;
   * - run only when the organization already has a saved profile: restoring
   *   "no profile" isn't possible by saving, so they never create one;
   * - wait for each save's own server response and check its own outcome,
   *   never a "Tallennettu." left on screen by an earlier save;
   * - verify what was persisted with a fresh page load;
   * - restore the exact original value in `finally`, from a freshly loaded
   *   form (the current version), so the restore itself never overwrites a
   *   change made meanwhile: it fails loudly on a conflict instead.
   */
  test("saving persists the change, then the original value is restored", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", MUTATING_PROJECT_REASON);
    await openBusinessDna(page);
    test.skip(!(await hasSavedProfile(page)), NO_PROFILE_REASON);

    const originalName = await page.locator("#displayName").inputValue();
    const temporaryName = `E2E-temp-${Date.now()}`;
    try {
      await page.locator("#displayName").fill(temporaryName);
      await expectSaved(page);
      expect(await freshValue(page, "#displayName")).toBe(temporaryName);
    } finally {
      await restoreValue(page, "#displayName", originalName);
    }
  });

  test("a form loaded before another save can't overwrite it, and keeps the typed edits", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", MUTATING_PROJECT_REASON);
    await openBusinessDna(page);
    test.skip(!(await hasSavedProfile(page)), NO_PROFILE_REASON);

    const staleTab = page; // loaded now, saved later
    const originalName = await staleTab.locator("#displayName").inputValue();
    const originalIndustry = await staleTab.locator("#industry").inputValue();
    const newerName = `E2E-temp-${Date.now()}`;
    const staleIndustry = `E2E-stale-${Date.now()}`;
    const otherTab = await page.context().newPage();
    try {
      // A newer change lands from another tab.
      await openBusinessDna(otherTab);
      await otherTab.locator("#displayName").fill(newerName);
      await expectSaved(otherTab);

      // The stale tab saves without reloading: refused, edits kept.
      await staleTab.locator("#industry").fill(staleIndustry);
      await expectConflict(staleTab);
      await expect(staleTab.locator("#industry")).toHaveValue(staleIndustry);

      // Nothing was overwritten.
      expect(await freshValue(otherTab, "#displayName")).toBe(newerName);
      expect(await freshValue(otherTab, "#industry")).toBe(originalIndustry);

      // "Load the latest version" discards the local edits and shows what is saved.
      await staleTab.getByRole("button", { name: FI.conflictReload }).click();
      await expect(staleTab.locator("#displayName")).toHaveValue(newerName);
      await expect(staleTab.locator("#industry")).toHaveValue(originalIndustry);
    } finally {
      await otherTab.close();
      await restoreValue(page, "#displayName", originalName);
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
