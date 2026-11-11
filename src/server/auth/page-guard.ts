import "server-only";

import { redirect } from "next/navigation";
import { assertPermission } from "@/server/auth/guard";
import {
  AuthError,
  assertAuthServiceAvailable,
  getSessionUser,
  getTenantContextOrNull,
  type TenantContext,
} from "@/server/auth/session";
import type { Permission } from "@/server/auth/permissions";
import { requireSuperadmin } from "@/server/auth/superadmin";

/*
 * Next.js renders a layout and its page in parallel, so a page's own guard
 * runs even when its layout has already decided the response (a redirect, or
 * a view that never renders the page). An AuthError the page throws then is
 * reported as an unhandled request error (Sentry), although the user only
 * sees the layout's redirect. These guards settle the same states the same
 * way their layout does, so a signed-out user, a user without an
 * organization or a non-superadmin is redirected, never reported.
 *
 * An auth-service failure also reaches these guards as "no user". It is not
 * an expected state: they throw AuthServiceUnavailableError for it instead of
 * redirecting, so an outage stays visible in error tracking.
 */

/**
 * For pages under (app): the tenant context, or the redirect (app)/layout.tsx
 * sends for the same state (no session or no usable membership). A missing
 * permission still throws a 403 AuthError, as requirePermission does; an
 * auth-service failure throws AuthServiceUnavailableError.
 */
export async function requirePagePermission(permission: Permission): Promise<TenantContext> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    await assertAuthServiceAvailable();
    redirect("/onboarding");
  }
  await assertPermission(ctx, permission);
  return ctx;
}

/**
 * Leaves the only trace of a signed-in user reaching the platform admin area
 * without the superadmin claim: the redirect that follows is silent. A log
 * line, not an AuditLog row, because audit rows belong to an organization and
 * this area has none. Only the user id is logged: never the email, the path
 * or anything from the request. Never throws, so it cannot change the
 * redirect.
 */
async function logSuperadminAccessDenied(): Promise<void> {
  try {
    // Request-cached: the same lookup requireSuperadmin() just made.
    const user = await getSessionUser();
    console.warn(
      JSON.stringify({
        event: "superadmin_access_denied",
        userId: user?.id ?? null,
        status: 403,
      }),
    );
  } catch {
    // never let a logging failure replace the redirect
  }
}

/**
 * For pages under (superadmin): the superadmin, or the redirect
 * (superadmin)/layout.tsx sends to anyone else. A signed-in user who is not a
 * superadmin is logged before the redirect. An auth-service failure throws
 * AuthServiceUnavailableError; any other failure still throws as it is.
 */
export async function requireSuperadminPage(): Promise<{ userId: string; email: string }> {
  try {
    return await requireSuperadmin();
  } catch (error) {
    if (error instanceof AuthError) {
      await assertAuthServiceAvailable();
      if (error.status === 403) await logSuperadminAccessDenied();
      redirect("/dashboard");
    }
    throw error;
  }
}
