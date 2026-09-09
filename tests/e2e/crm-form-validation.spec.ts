import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Contact creation's required-field enforcement is a native HTML `required`
 * attribute (src/components/crm/contact-dialog.tsx) — this only blocks
 * submission in a real browser's constraint-validation engine, which no
 * Vitest/jsdom-based test exercises. Proves the dialog can't be submitted
 * empty, without creating a contact.
 */
test.describe("crm form validation", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("creating a contact with no first name is blocked client-side", async ({ page }) => {
    await page.goto("/crm/contacts");
    await page.getByRole("button", { name: /uusi kontakti|new contact/i }).click();

    const firstName = page.locator("#firstName");
    await expect(firstName).toBeVisible();
    await expect(firstName).toHaveAttribute("required", "");

    await page.getByRole("button", { name: /^luo$|^create$/i }).click();

    // The browser's own constraint validation must have blocked the submit:
    // the dialog is still open and the field reports itself invalid.
    await expect(firstName).toBeVisible();
    const isValid = await firstName.evaluate((el: HTMLInputElement) => el.validity.valid);
    expect(isValid).toBe(false);
  });
});
