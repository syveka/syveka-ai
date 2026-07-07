import { test, expect } from "@playwright/test";

/**
 * Critical-journey smoke suite (§23). Runs against preview/staging.
 * Auth journeys need E2E_USER_EMAIL / E2E_USER_PASSWORD seeded on the target env.
 */

test.describe("public", () => {
  test("landing renders in Finnish by default", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText(/tekoäly/i);
    await expect(page.getByRole("link", { name: /kirjaudu/i })).toBeVisible();
  });

  test("locale switch: English + Arabic RTL", async ({ page }) => {
    await page.goto("/en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.goto("/ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("unauthenticated dashboard access redirects to login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("health endpoint is green", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("healthy");
  });
});

test.describe("authenticated", () => {
  test.skip(!process.env.E2E_USER_EMAIL, "requires seeded E2E user");

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.fill("#email", process.env.E2E_USER_EMAIL!);
    await page.fill("#password", process.env.E2E_USER_PASSWORD!);
    await page.getByRole("button", { name: /kirjaudu|log in/i }).click();
    await page.waitForURL(/\/dashboard/);
  });

  test("dashboard shows KPI cards", async ({ page }) => {
    await expect(page.getByText(/avoimet kaupat|open deals/i)).toBeVisible();
  });

  test("chat streams a reply", async ({ page }) => {
    await page.goto("/chat");
    await page.getByPlaceholder(/viesti|message/i).fill("Hei! Mitä osaat tehdä?");
    await page.keyboard.press("Enter");
    // assistant bubble appears and grows (streaming)
    const bubble = page.locator("[class*=bg-muted]").last();
    await expect(bubble).toBeVisible({ timeout: 30_000 });
  });

  test("CRM contact create → visible in list", async ({ page }) => {
    await page.goto("/crm/contacts");
    await page.getByRole("button", { name: /uusi kontakti|new contact/i }).click();
    const name = `E2E-${Date.now()}`;
    await page.fill("#firstName", name);
    await page.getByRole("button", { name: /^luo$|^create$/i }).click();
    await expect(page.getByText(name)).toBeVisible();
  });

  test("deals kanban renders default pipeline", async ({ page }) => {
    await page.goto("/crm/deals");
    await expect(page.getByText("Uusi liidi")).toBeVisible();
    await expect(page.getByText("Voitettu")).toBeVisible();
  });
});
