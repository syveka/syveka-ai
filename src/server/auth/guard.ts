import "server-only";

import { AuthError, getTenantContext, type TenantContext } from "@/server/auth/session";
import { can, type Permission } from "@/server/auth/permissions";
import { audit } from "@/server/services/audit";

/**
 * Entry-point guard for every Server Action and API handler (§12.3).
 * Throws 403 and audit-logs denials on sensitive resources.
 */
export async function requirePermission(permission: Permission): Promise<TenantContext> {
  const ctx = await getTenantContext();

  if (!can(ctx.role, permission)) {
    const sensitive = ["members:", "billing:", "api-keys:", "org:", "audit:", "integrations:"];
    if (sensitive.some((s) => permission.startsWith(s))) {
      await audit(ctx, {
        action: "authz.denied",
        resourceType: "permission",
        resourceId: permission,
      }).catch(() => undefined); // never let audit failure mask the 403
    }
    throw new AuthError(`Missing permission: ${permission}`, 403);
  }

  return ctx;
}
