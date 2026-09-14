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
} from "@/lib/validators/entitlement-grants";
import { AuthError } from "@/server/auth/session";
import type { EntitlementMetric } from "@prisma/client";

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
