import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { loginAsE2EUser } from "./helpers/auth";
import { hasDbAccess, getDbClient } from "./helpers/db";

function hasSupabaseAdminAccess(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/**
 * Establishes a real recovery session the same way GoTrue itself does --
 * `verifyOtp({ token_hash, type: "recovery" })` -- and captures the exact
 * cookies `@supabase/ssr` would write for it, using the library's own
 * cookie-writing code (never hand-encoded), so they're byte-for-byte what our
 * app's own createSupabaseServer()/createSupabaseRouteClient() would produce.
 *
 * Why not drive this through the browser via the admin-generated action_link,
 * the way a real emailed link would work: Supabase Admin's generateLink() has
 * no originating browser/code-verifier (there is no "user's browser" for an
 * admin-triggered link), so GoTrue can only ever hand back an *implicit-flow*
 * link (`#access_token=...&refresh_token=...`), never the PKCE `?code=` link
 * `resetPasswordForEmail()` produces for a real user-initiated reset --
 * confirmed empirically (staging run 34059627597's password-recovery
 * failure: `page.goto(actionLink)` landed on
 * `.../#access_token=[redacted]`, never on /reset-password, because that
 * fragment is client-side-only and our server-rendered app never reads it).
 * generateLink()'s `hashed_token` is the one property from that response
 * that lets a *server-side* client complete the same underlying GoTrue
 * "verify recovery" operation deterministically, without a real email and
 * without ever needing a browser-originated PKCE code_verifier.
 *
 * This intentionally does not exercise /api/auth/callback's own
 * exchangeCodeForSession(code) call -- that route is generic infrastructure
 * already exercised by the signup/magic-link flows, not recovery-specific.
 * What this proves, and what the original bug was actually about, is
 * everything downstream of "a recovery session now exists": middleware
 * letting it reach /reset-password (the exact defect fixed in 4037d03), the
 * real form, the real resetPasswordAction, and the real new password
 * authenticating afterward.
 */
async function establishRecoverySessionCookies(params: {
  supabaseUrl: string;
  supabaseKey: string;
  tokenHash: string;
}): Promise<Array<{ name: string; value: string; options: CookieOptions }>> {
  const captured: Array<{ name: string; value: string; options: CookieOptions }> = [];
  const client = createServerClient(params.supabaseUrl, params.supabaseKey, {
    cookies: {
      getAll: () => [],
      setAll: (cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) =>
        captured.push(...cookiesToSet),
    },
  });

  const { error } = await client.auth.verifyOtp({
    token_hash: params.tokenHash,
    type: "recovery",
  });
  if (error) throw new Error(`verifyOtp(type: "recovery") failed: ${error.message}`);
  if (captured.length === 0) {
    throw new Error("verifyOtp succeeded but wrote no session cookies -- nothing to inject.");
  }
  return captured;
}

/**
 * A real staging recovery attempt (manually triggered from the Supabase
 * dashboard) surfaced a middleware bug: exchanging a recovery link's code
 * establishes a real session by design, but middleware.ts treated
 * /reset-password exactly like /login (bounce any authenticated visitor to
 * /dashboard) — so no one could ever reach the update-password form. Fixed in
 * middleware.ts (4037d03).
 *
 * Runs against a disposable throwaway account created and destroyed entirely
 * within this test — never the shared E2E fixture user, never any real
 * account. Never sends a real email: generateLink() only reads
 * `properties.hashed_token`, and verifyOtp() is a direct, synchronous
 * server-to-server call — no email delivery is involved at any point.
 */
test.describe("password recovery", () => {
  test("a recovery session reaches reset-password, and the new password actually signs in", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !hasSupabaseAdminAccess(),
      "Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (staging-only; never available in Tier-A CI).",
    );

    const supabaseUrl = process.env.SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const email = `e2e-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}@syveka-e2e.invalid`;
    const originalPassword = `Orig-${Math.random().toString(36).slice(2)}-Aa1!`;
    const newPassword = `New-${Math.random().toString(36).slice(2)}-Bb2!`;

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: originalPassword,
      email_confirm: true,
    });
    expect(createError, createError?.message).toBeNull();
    const userId = created!.user!.id;

    try {
      const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
        type: "recovery",
        email,
      });
      expect(linkError, linkError?.message).toBeNull();
      const tokenHash = linkData?.properties?.hashed_token;
      expect(tokenHash, "generateLink() did not return properties.hashed_token").toBeTruthy();

      const sessionCookies = await establishRecoverySessionCookies({
        supabaseUrl,
        supabaseKey: serviceRoleKey,
        tokenHash: tokenHash!,
      });
      await page.context().addCookies(
        sessionCookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          url: baseURL,
        })),
      );

      // The recovery session cookie is now present exactly as if
      // /api/auth/callback had just set it -- this is the precise point the
      // real flow reaches right before redirecting to /reset-password.
      await page.goto("/fi/reset-password");
      await expect(page).toHaveURL(/\/reset-password/);

      await page.fill("#password", newPassword);
      await page.getByRole("button", { name: /tallenna|save/i }).click();
      await expect(page).not.toHaveURL(/\/reset-password/, { timeout: 10_000 });

      // Definitive proof the new password took effect: end this session and
      // sign back in with it through the real login form, reusing the same
      // helper (and its form-scoped alert detection) every other spec trusts.
      await page.getByRole("button", { name: "logout" }).click();
      await expect(page).toHaveURL(/\/login/);

      const savedEmail = process.env.E2E_USER_EMAIL;
      const savedPassword = process.env.E2E_USER_PASSWORD;
      process.env.E2E_USER_EMAIL = email;
      process.env.E2E_USER_PASSWORD = newPassword;
      try {
        await loginAsE2EUser(page);
      } finally {
        if (savedEmail === undefined) delete process.env.E2E_USER_EMAIL;
        else process.env.E2E_USER_EMAIL = savedEmail;
        if (savedPassword === undefined) delete process.env.E2E_USER_PASSWORD;
        else process.env.E2E_USER_PASSWORD = savedPassword;
      }
    } finally {
      // handle_new_user() syncs auth.users -> public.users on creation, but
      // there is no reverse trigger on deletion (see the
      // 20260902000000_handle_new_user_email_reconciliation migration) --
      // deleting public.users first avoids leaving this throwaway account's
      // row behind as exactly the kind of stale-row hazard that migration
      // exists to reconcile.
      if (hasDbAccess()) {
        await getDbClient()
          .user.delete({ where: { id: userId } })
          .catch(() => {});
      }
      await admin.auth.admin.deleteUser(userId).catch((error) => {
        console.error("password-recovery cleanup: failed to delete throwaway auth user", error);
      });
    }
  });
});
