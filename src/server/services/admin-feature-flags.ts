import "server-only";

import { requireSuperadmin } from "@/server/auth/superadmin";
import { audit } from "./audit";
import { isFeatureEnabled, setFeatureEnabled } from "./feature-flags";

/**
 * Per-organization feature flags a superadmin may switch from /admin.
 * creator_studio_v1 opens Creator Studio. Every generation still reserves
 * credits first (creator-credits.ts) and a FREE organization gets none, so
 * turning it on never enables a paid provider call by itself. It does let
 * members connect a social account (Meta OAuth, their own action) and
 * schedule approved posts to it, which publishes externally; the admin page
 * says so. creator_studio_autopilot is deliberately not toggleable.
 */
export const ADMIN_TOGGLEABLE_FEATURES = ["creator_studio_v1"] as const;
export type AdminToggleableFeature = (typeof ADMIN_TOGGLEABLE_FEATURES)[number];

export class InvalidFeatureToggleError extends Error {}

export function isAdminToggleableFeature(key: string): key is AdminToggleableFeature {
  return (ADMIN_TOGGLEABLE_FEATURES as readonly string[]).includes(key);
}

/** Superadmin-only; audited in the organization's own audit log. */
export async function setOrganizationFeatureAsSuperadmin(params: {
  organizationId: string;
  key: string;
  enabled: boolean;
  reason: string;
}): Promise<void> {
  const admin = await requireSuperadmin();

  if (!isAdminToggleableFeature(params.key)) {
    throw new InvalidFeatureToggleError("This feature can't be switched from the admin page.");
  }
  const reason = params.reason.trim();
  if (!reason) throw new InvalidFeatureToggleError("A reason is required.");

  const before = await isFeatureEnabled(params.organizationId, params.key);
  if (before === params.enabled) return;
  await setFeatureEnabled(params.organizationId, params.key, params.enabled);

  await audit(
    { orgId: params.organizationId, userId: admin.userId },
    {
      action: "feature_flag.update",
      resourceType: "organization",
      resourceId: params.organizationId,
      actorType: "user",
      before: { [params.key]: before },
      after: { [params.key]: params.enabled, reason },
    },
  ).catch(() => undefined);
}
