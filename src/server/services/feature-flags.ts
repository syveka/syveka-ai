import "server-only";

import { patchOrganizationSettings } from "./organization-settings";
import { unscopedPrisma } from "@/server/db/tenant";

export class FeatureDisabledError extends Error {
  readonly code = "feature_disabled";
}

/**
 * Minimal per-organization feature flag mechanism. No dedicated flag table
 * exists yet in this codebase (confirmed by repo audit — see
 * docs/creator-studio.md), so this repurposes Organization.settings, the
 * existing generic per-org JSON config bag, rather than standing up new
 * infrastructure for a single feature ("creator_studio_v1",
 * "creator_studio_autopilot"). A fresh org has every key unset (disabled)
 * until explicitly turned on.
 */
export async function isFeatureEnabled(orgId: string, key: string): Promise<boolean> {
  const org = await unscopedPrisma.organization.findUnique({
    where: { id: orgId },
    select: { settings: true },
  });
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  return settings[key] === true;
}

/**
 * For a flag that RESTRICTS an organization: anything other than an absent
 * key or JSON false counts as set, so a mistyped value ("true", 1) restricts
 * instead of silently leaving the organization unrestricted.
 */
export async function isRestrictionSet(orgId: string, key: string): Promise<boolean> {
  const org = await unscopedPrisma.organization.findUnique({
    where: { id: orgId },
    select: { settings: true },
  });
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  return key in settings && settings[key] !== false && settings[key] !== null;
}

export async function setFeatureEnabled(
  orgId: string,
  key: string,
  enabled: boolean,
): Promise<void> {
  // Only this key changes, atomically (operator-only keys are refused).
  const updated = await patchOrganizationSettings(orgId, { set: { [key]: enabled } });
  if (updated !== 1) throw new Error("Organization not found");
}

export async function assertFeatureEnabled(orgId: string, key: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, key))) {
    throw new FeatureDisabledError(`Feature "${key}" is not enabled for this organization.`);
  }
}
