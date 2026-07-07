import "server-only";

import { getSessionUser, AuthError } from "@/server/auth/session";

/**
 * Superadmin gate (§12.4): separate axis from org RBAC.
 * Claim comes from auth.users.app_metadata.is_superadmin (set manually by
 * platform ops via Supabase dashboard — never grantable from app UI).
 */
export async function requireSuperadmin() {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Not authenticated", 401);
  if (user.app_metadata?.is_superadmin !== true) {
    throw new AuthError("Superadmin required", 403);
  }
  return { userId: user.id, email: user.email ?? "" };
}
