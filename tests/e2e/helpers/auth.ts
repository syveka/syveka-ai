import type { Page } from "@playwright/test";

const LOGIN_OUTCOME_TIMEOUT_MS = 15_000;
const APP_LOCALES = new Set(["fi", "en", "ar"]);

type LoginRoute = "dashboard" | "login" | "onboarding" | "unexpected";

export function classifyE2ELoginPathname(pathname: string): LoginRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] && APP_LOCALES.has(segments[0])) segments.shift();
  const unprefixed = `/${segments.join("/")}`;

  if (/^\/dashboard\/?$/.test(unprefixed)) return "dashboard";
  if (/^\/login\/?$/.test(unprefixed)) return "login";
  if (/^\/onboarding\/?$/.test(unprefixed)) return "onboarding";
  return "unexpected";
}

export function requireE2EUserCredentials(): void {
  if (!process.env.E2E_USER_EMAIL || !process.env.E2E_USER_PASSWORD) {
    throw new Error("This spec requires E2E_USER_EMAIL and E2E_USER_PASSWORD.");
  }
}

/**
 * Playwright's own failure diagnostics (error-context.md's ARIA "Page
 * snapshot", generated on every test failure regardless of trace/screenshot
 * config -- confirmed directly, there is no config flag to suppress it)
 * include the live value of any visible form field, unmasked, even for
 * type="password" inputs. Every loginDiagnostic() call site throws shortly
 * after typing the real E2E password into #password, so it must be cleared
 * first or that password ends up captured in plain text in a failure
 * artifact. Best-effort: the field may not exist on every page this is
 * called from (e.g. once already on /dashboard).
 */
async function clearPasswordField(page: Page): Promise<void> {
  await page
    .locator("#password")
    .fill("", { timeout: 1_000 })
    .catch(() => {});
}

async function loginDiagnostic(page: Page, reason: string): Promise<Error> {
  await clearPasswordField(page);
  const url = new URL(page.url());
  const alert = page.getByRole("alert");
  const alertText = (await alert.isVisible().catch(() => false))
    ? ((await alert.textContent().catch(() => null))?.trim() ?? "visible (no text)")
    : "not visible";
  const documentState = await page.evaluate(() => document.readyState).catch(() => "unavailable");

  return new Error(
    `E2E authentication failed: ${reason}; pathname=${JSON.stringify(`${url.pathname}${url.search}`)}; ` +
      `route=${classifyE2ELoginPathname(url.pathname)}; alert=${JSON.stringify(alertText)}; ` +
      `documentState=${documentState}`,
  );
}

async function requireDashboardRoute(page: Page, source: string): Promise<void> {
  const url = new URL(page.url());
  const route = classifyE2ELoginPathname(url.pathname);
  if (route === "dashboard") return;
  if (route === "onboarding") {
    throw await loginDiagnostic(
      page,
      `${source} reached onboarding, so the authenticated user has no usable organization context`,
    );
  }
  if (route === "login") {
    throw await loginDiagnostic(
      page,
      `${source} returned to login (credentials rejected, rate limited, or session validation failed)`,
    );
  }
  throw await loginDiagnostic(page, `${source} reached an unexpected route`);
}

export async function openAuthenticatedE2EDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard", { timeout: LOGIN_OUTCOME_TIMEOUT_MS }).catch(async () => {
    throw await loginDiagnostic(
      page,
      `stored E2E session navigation did not complete within ${LOGIN_OUTCOME_TIMEOUT_MS}ms`,
    );
  });
  await requireDashboardRoute(page, "stored E2E session");
}

export async function loginAsE2EUser(
  page: Page,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await page.goto("/login");
  await page.fill("#email", process.env.E2E_USER_EMAIL!);
  await page.fill("#password", process.env.E2E_USER_PASSWORD!);
  const initialUrl = page.url();
  await page
    .getByRole("button", { name: /kirjaudu|log in/i })
    .click({ timeout: 10_000 })
    .catch(async () => {
      throw await loginDiagnostic(page, "login submission did not complete within 10000ms");
    });

  const timeoutMs = options.timeoutMs ?? LOGIN_OUTCOME_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const url = new URL(page.url());
    const route = classifyE2ELoginPathname(url.pathname);
    const alertVisible = await page
      .getByRole("alert")
      .isVisible()
      .catch(() => false);

    if (route === "dashboard") {
      await page
        .waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) })
        .catch(async () => {
          throw await loginDiagnostic(page, "dashboard navigation did not finish loading");
        });
      await requireDashboardRoute(page, "login");
      return;
    }
    if (alertVisible) {
      throw await loginDiagnostic(page, "the login form reported an authentication error");
    }
    if (route === "onboarding") {
      throw await loginDiagnostic(
        page,
        "login reached onboarding, so the authenticated user has no usable organization context",
      );
    }
    if (route === "unexpected") {
      throw await loginDiagnostic(page, "login reached an unexpected route");
    }
    if (page.url() !== initialUrl) {
      throw await loginDiagnostic(page, "login redirected back to the login route");
    }

    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }

  throw await loginDiagnostic(page, `no post-login outcome appeared within ${timeoutMs}ms`);
}
