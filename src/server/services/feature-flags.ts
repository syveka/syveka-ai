import "server-only";

import type { Prisma } from "@prisma/client";
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

export async function setFeatureEnabled(
  orgId: string,
  key: string,
  enabled: boolean,
): Promise<void> {
  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true },
  });
  const settings = {
    ...(org.settings as Record<string, unknown>),
    [key]: enabled,
  } as Prisma.InputJsonValue;
  await unscopedPrisma.organization.update({ where: { id: orgId }, data: { settings } });
}

export async function assertFeatureEnabled(orgId: string, key: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, key))) {
    throw new FeatureDisabledError(`Feature "${key}" is not enabled for this organization.`);
  }
}
