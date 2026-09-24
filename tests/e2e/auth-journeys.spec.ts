import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { classifyE2ELoginPathname } from "./helpers/auth";

/**
 * Opt-in staging auth journeys, run by staging-release.yml against the
 * stable staging host (NEXT_PUBLIC_APP_URL) after it has been proven to
 * serve the release candidate. Gated behind E2E_AUTH_JOURNEYS=1 because the
 * recovery journey changes the shared E2E account's password; the workflow
 * restores it afterwards (scripts/ensure-e2e-auth-journey-fixtures.ts).
 *
 * The recovery link is rebuilt exactly as Supabase's default recovery email
 * builds it ({SUPABASE_URL}/auth/v1/verify?token=<recovery token>&type=
 * recovery&redirect_to=<the app's redirectTo>), reading only the E2E
 * account's own recovery token -- so the real Supabase verify endpoint, its
 * redirect allowlist, the PKCE exchange and the app's callback all run for
 * real, without needing a mailbox.
 *
 * Never traced/screenshotted: these tests type real test credentials.
 * Failure messages carry pathnames only, never queries, tokens or emails.
 */

const JOURNEYS_ENABLED = process.env.E2E_AUTH_JOURNEYS === "1";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`auth journeys require ${name}`);
  return value;
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/en/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: /kirjaudu|log in/i }).click();
  await page.waitForURL((url) => classifyE2ELoginPathname(url.pathname) !== "login", {
    timeout: 20_000,
  });
}

async function readRecoveryState(
  userId: string,
): Promise<{ token: string | null; sentAt: string | null }> {
  const db = new Client({ connectionString: requireEnv("E2E_DIRECT_URL") });
  await db.connect();
  try {
    const { rows } = await db.query<{ token: string | null; sent_at: string | null }>(
      "select recovery_token as token, recovery_sent_at::text as sent_at from auth.users where id = $1",
      [userId],
    );
    return { token: rows[0]?.token || null, sentAt: rows[0]?.sent_at ?? null };
  } finally {
    await db.end();
  }
}

// trace/screenshot/video are worker-scoped: Playwright refuses to load the
// file if they are set inside a describe group, so they are file-level here.
test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("auth journeys on the stable staging host (opt-in)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(() => {
    test.skip(
      !JOURNEYS_ENABLED,
      "Opt-in: set E2E_AUTH_JOURNEYS=1 (changes the shared E2E account password; the staging workflow restores it).",
    );
    test.skip(
      test.info().project.name !== "desktop",
      "Runs once (desktop): the journeys mutate shared test-account state.",
    );
  });

  test("password recovery from the stable host reaches reset-password, then the dashboard; a fresh login reaches the dashboard", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const email = requireEnv("E2E_USER_EMAIL");
    const userId = requireEnv("E2E_RECOVERY_USER_ID");
    const supabaseUrl = new URL(requireEnv("E2E_SUPABASE_URL")).origin;
    const origin = new URL(baseURL!).origin;
    const newPassword = randomBytes(24).toString("base64url");

    const before = await readRecoveryState(userId);

    await page.goto("/en/forgot-password");
    await page.fill("#email", email);
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByText(/check your inbox/i)).toBeVisible({ timeout: 20_000 });

    let token: string | null = null;
    for (let attempt = 0; attempt < 30 && !token; attempt++) {
      const state = await readRecoveryState(userId);
      if (state.token && state.sentAt !== before.sentAt) token = state.token;
      else await page.waitForTimeout(1_000);
    }
    expect(token, "Supabase issued no new recovery token for the E2E account").toBeTruthy();

    // Exactly what src/actions/auth.ts's authCallbackUrl() sends as redirectTo.
    const redirectTo = `${origin}/api/auth/callback?next=${encodeURIComponent("/en/reset-password")}`;
    const verifyUrl =
      `${supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(token!)}` +
      `&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`;
    await page.goto(verifyUrl);
    await page
      .waitForURL((url) => url.origin === origin && url.pathname === "/en/reset-password", {
        timeout: 30_000,
      })
      .catch(() => {
        const landed = new URL(page.url());
        throw new Error(
          `recovery link did not reach ${origin}/en/reset-password; landed on ` +
            `${landed.origin === origin ? "" : "a different host "}${landed.pathname}`,
        );
      });

    await page.fill("#password", newPassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((url) => classifyE2ELoginPathname(url.pathname) === "dashboard", {
      timeout: 30_000,
    });
    expect(classifyE2ELoginPathname(pathOf(page))).toBe("dashboard");

    await page.context().clearCookies();
    await signIn(page, email, newPassword);
    expect(
      classifyE2ELoginPathname(pathOf(page)),
      `fresh login after recovery landed on ${pathOf(page)}`,
    ).toBe("dashboard");
  });

  test("a genuine new user with no organization lands on onboarding (the form is never submitted)", async ({
    page,
  }) => {
    await signIn(page, requireEnv("E2E_NO_ORG_USER_EMAIL"), requireEnv("E2E_NO_ORG_USER_PASSWORD"));
    expect(
      classifyE2ELoginPathname(pathOf(page)),
      `no-membership login landed on ${pathOf(page)}`,
    ).toBe("onboarding");
    await expect(page.getByText(/Create your organization|Luo organisaatiosi/)).toBeVisible();
  });
});
