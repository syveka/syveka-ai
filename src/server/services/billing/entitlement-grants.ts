import "server-only";

import type { EntitlementMetric } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { audit } from "@/server/services/audit";
import { invalidateEntitlements } from "./entitlements";

export { listActiveGrants, listAllGrants, METRIC_TO_PLAN_LIMIT_KEY } from "./entitlements";
export type { ActiveGrant } from "./entitlements";

export class InvalidGrantError extends Error {}

/**
 * Superadmin-only write path. `amount` must be a positive integer -- a
 * grant can only ever add capacity, never remove it (removing capacity is
 * what `revokeEntitlementOverride` is for). Every call writes both the
 * grant row itself (already a ledger) and a mirrored AuditLog entry, and
 * invalidates the org's cached entitlements so the change takes effect
 * immediately rather than waiting out the 60s cache TTL.
 */
export async function grantEntitlementOverride(params: {
  organizationId: string;
  metric: EntitlementMetric;
  amount: number;
  reason: string;
  expiresAt?: Date | null;
}): Promise<{ id: string }> {
  const admin = await requireSuperadmin();

  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new InvalidGrantError("Grant amount must be a positive integer.");
  }
  if (!params.reason.trim()) {
    throw new InvalidGrantError("A reason is required for every entitlement grant.");
  }
  if (params.expiresAt && params.expiresAt.getTime() <= Date.now()) {
    throw new InvalidGrantError("Expiration must be in the future.");
  }

  const grant = await unscopedPrisma.entitlementGrant.create({
    data: {
      organizationId: params.organizationId,
      metric: params.metric,
      amount: params.amount,
      reason: params.reason.trim(),
      grantedByUserId: admin.userId,
      expiresAt: params.expiresAt ?? null,
    },
  });

  await audit(
    { orgId: params.organizationId, userId: admin.userId },
    {
      action: "entitlement_grant.create",
      resourceType: "entitlement_grant",
      resourceId: grant.id,
      actorType: "user",
      after: {
        metric: params.metric,
        amount: params.amount,
        reason: grant.reason,
        expiresAt: params.expiresAt?.toISOString() ?? null,
      },
    },
  ).catch(() => undefined);

  await invalidateEntitlements(params.organizationId);
  return { id: grant.id };
}

/** Superadmin-only. Idempotent: revoking an already-revoked grant is a no-op, not an error. */
export async function revokeEntitlementOverride(grantId: string): Promise<void> {
  const admin = await requireSuperadmin();

  const grant = await unscopedPrisma.entitlementGrant.findUniqueOrThrow({
    where: { id: grantId },
  });
  if (grant.revokedAt) return;

  await unscopedPrisma.entitlementGrant.update({
    where: { id: grantId },
    data: { revokedAt: new Date(), revokedByUserId: admin.userId },
  });

  await audit(
    { orgId: grant.organizationId, userId: admin.userId },
    {
      action: "entitlement_grant.revoke",
      resourceType: "entitlement_grant",
      resourceId: grant.id,
      actorType: "user",
      after: { metric: grant.metric, amount: grant.amount, reason: grant.reason },
    },
  ).catch(() => undefined);

  await invalidateEntitlements(grant.organizationId);
}
