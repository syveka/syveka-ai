import type { Page } from "@playwright/test";

/**
 * Shared authenticated-login flow for Playwright specs. `smoke.spec.ts`
 * predates this helper and keeps its own inline copy — not refactored here
 * per the "don't rewrite a stable, working test file just to fit a new
 * abstraction" rule. New specs (e.g. business-dna.spec.ts) should use this
 * instead of copy-pasting the flow a third time.
 */
export function requireE2EUserCredentials(): void {
  if (!process.env.E2E_USER_EMAIL || !process.env.E2E_USER_PASSWORD) {
    throw new Error("This spec requires E2E_USER_EMAIL and E2E_USER_PASSWORD.");
  }
}

export async function loginAsE2EUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.fill("#email", process.env.E2E_USER_EMAIL!);
  await page.fill("#password", process.env.E2E_USER_PASSWORD!);
  await page.getByRole("button", { name: /kirjaudu|log in/i }).click();
  await page.waitForURL(/\/dashboard/);
}
