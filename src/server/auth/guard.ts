import "server-only";

import { AuthError, getTenantContext, type TenantContext } from "@/server/auth/session";
import { can, type Permission } from "@/server/auth/permissions";
import { audit } from "@/server/services/audit";

/**
 * Records a denied permission check (§12.3). Every denial is recorded, so a
 * member probing endpoints they lack access to leaves a trail whatever the
 * permission. Only the permission name is stored: never request input,
 * payloads or credentials. Never throws, so an audit failure cannot mask
 * the 403.
 */
export async function auditDenial(
  ctx: Pick<TenantContext, "orgId" | "userId">,
  permission: Permission,
): Promise<void> {
  try {
    await audit(ctx, {
      action: "authz.denied",
      resourceType: "permission",
      resourceId: permission,
    });
  } catch {
    // never let an audit failure (rejected or thrown) mask the 403
  }
}

/**
 * Entry-point guard for every Server Action and API handler (§12.3).
 * Throws 403 and audit-logs every denial.
 */
export async function requirePermission(permission: Permission): Promise<TenantContext> {
  const ctx = await getTenantContext();
  await assertPermission(ctx, permission);
  return ctx;
}

/**
 * The same check for an additional permission once the caller already holds
 * a context (an action that needs two permissions). Throws 403 and
 * audit-logs the denial.
 */
export async function assertPermission(ctx: TenantContext, permission: Permission): Promise<void> {
  if (!can(ctx.role, permission)) {
    await auditDenial(ctx, permission);
    throw new AuthError(`Missing permission: ${permission}`, 403);
  }
}
