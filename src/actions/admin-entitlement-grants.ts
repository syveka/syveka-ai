"use server";

import { revalidatePath } from "next/cache";
import {
  grantEntitlementOverride,
  revokeEntitlementOverride,
  InvalidGrantError,
} from "@/server/services/billing/entitlement-grants";
import {
  createEntitlementGrantSchema,
  revokeEntitlementGrantSchema,
  setOrganizationFeatureSchema,
} from "@/lib/validators/entitlement-grants";
import {
  InvalidFeatureToggleError,
  setOrganizationFeatureAsSuperadmin,
} from "@/server/services/admin-feature-flags";
import { AuthError } from "@/server/auth/session";
import type { EntitlementMetric } from "@/generated/prisma/client/client";

export type EntitlementGrantActionState = { error?: string; message?: string };

/**
 * Internal/pilot entitlement grants -- never a Stripe subscription, never a
 * change to Subscription.plan (see src/server/services/billing/entitlement-
 * grants.ts and prisma/schema.prisma's EntitlementGrant doc comment).
 * requireSuperadmin() inside grantEntitlementOverride() is the actual
 * authorization boundary; this action layer adds no privilege of its own.
 */
export async function createEntitlementGrantAction(
  _prev: EntitlementGrantActionState,
  formData: FormData,
): Promise<EntitlementGrantActionState> {
  const parsed = createEntitlementGrantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await grantEntitlementOverride({
      organizationId: parsed.data.organizationId,
      metric: parsed.data.metric as EntitlementMetric,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    if (e instanceof InvalidGrantError) return { error: e.message };
    return { error: "failed" };
  }

  revalidatePath(`/admin/organizations/${parsed.data.organizationId}`);
  return { message: "Grant created." };
}

export async function revokeEntitlementGrantAction(
  _prev: EntitlementGrantActionState,
  formData: FormData,
): Promise<EntitlementGrantActionState> {
  const parsed = revokeEntitlementGrantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await revokeEntitlementOverride(parsed.data.grantId);
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    return { error: "failed" };
  }

  revalidatePath(`/admin/organizations/${parsed.data.organizationId}`);
  return { message: "Grant revoked." };
}

/**
 * Superadmin switch for an organization's screen-level feature flag (see
 * src/server/services/admin-feature-flags.ts). requireSuperadmin() inside
 * the service is the authorization boundary.
 */
export async function setOrganizationFeatureAction(
  _prev: EntitlementGrantActionState,
  formData: FormData,
): Promise<EntitlementGrantActionState> {
  const parsed = setOrganizationFeatureSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await setOrganizationFeatureAsSuperadmin(parsed.data);
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    if (e instanceof InvalidFeatureToggleError) return { error: e.message };
    return { error: "failed" };
  }

  revalidatePath(`/admin/organizations/${parsed.data.organizationId}`);
  return { message: parsed.data.enabled ? "Feature enabled." : "Feature disabled." };
}
