import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { loginAsE2EUser } from "./helpers/auth";
import { hasDbAccess, getDbClient } from "./helpers/db";

function hasSupabaseAdminAccess(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/**
 * A real staging recovery attempt (manually triggered from the Supabase
 * dashboard) surfaced a middleware bug: exchanging a recovery link's code
 * establishes a real session by design, but middleware.ts treated
 * /reset-password exactly like /login (bounce any authenticated visitor to
 * /dashboard) — so no one could ever reach the update-password form. Fixed in
 * middleware.ts; this proves the *app-triggered* flow (forgot-password's own
 * redirectTo, unlike a dashboard-triggered reset which bypasses it entirely —
 * a Supabase project-configuration concern, not something this app's code
 * controls) end to end, without ever sending a real email.
 *
 * Supabase's Admin API `generateLink()` returns the exact same recovery link
 * a real email would contain but never triggers delivery — that's what makes
 * this safe to run automatically rather than a reason to gate it further.
 * It still requires the staging service-role key (never present in Tier-A's
 * ephemeral-Postgres CI run, so this always skips there) and runs against a
 * disposable throwaway account created and destroyed entirely within this
 * test — never the shared E2E fixture user, never any real account.
 */
test.describe("password recovery", () => {
  test("recovery link lands on reset-password, and the new password actually signs in", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !hasSupabaseAdminAccess(),
      "Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (staging-only; never available in Tier-A CI).",
    );

    const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
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
      const redirectTo = `${baseURL}/api/auth/callback?next=${encodeURIComponent("/fi/reset-password")}`;
      const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo },
      });
      expect(linkError, linkError?.message).toBeNull();
      const actionLink = linkData?.properties?.action_link;
      expect(actionLink).toBeTruthy();

      // Not a real email -- generateLink() never sends one. This is the same
      // link a real recovery email would contain, followed the same way a
      // user clicking it would.
      await page.goto(actionLink!);
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
