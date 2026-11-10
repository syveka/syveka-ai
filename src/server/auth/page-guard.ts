import "server-only";

import { redirect } from "next/navigation";
import { assertPermission } from "@/server/auth/guard";
import { AuthError, getTenantContextOrNull, type TenantContext } from "@/server/auth/session";
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
 */

/**
 * For pages under (app): the tenant context, or the redirect (app)/layout.tsx
 * sends for the same state (no session or no usable membership). A missing
 * permission still throws a 403 AuthError, as requirePermission does.
 */
export async function requirePagePermission(permission: Permission): Promise<TenantContext> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) redirect("/onboarding");
  await assertPermission(ctx, permission);
  return ctx;
}

/**
 * For pages under (superadmin): the superadmin, or the redirect
 * (superadmin)/layout.tsx sends to anyone else. Any other failure still throws.
 */
export async function requireSuperadminPage(): Promise<{ userId: string; email: string }> {
  try {
    return await requireSuperadmin();
  } catch (error) {
    if (error instanceof AuthError) redirect("/dashboard");
    throw error;
  }
}
