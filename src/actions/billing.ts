"use server";

import { redirect } from "next/navigation";
import type { Plan } from "@/generated/prisma/client/client";

type BillingInterval = "monthly" | "annual";

/**
 * A plan choice from the plan cards. An organization without a subscription
 * gets a Checkout; one that already has a subscription goes to the Stripe
 * Billing Portal to change it (see startPlanChange). A refusal (busy, or the
 * rate limit or lock can't be verified) returns to the billing page saying so.
 */
export async function startCheckoutAction(plan: Plan, interval: BillingInterval): Promise<void> {
  const [{ requirePermission }, { startPlanChange }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/billing/plan-change"),
  ]);

  const ctx = await requirePermission("billing:manage");
  // Bound by the plan cards, but still client-supplied: only self-serve plans.
  if (!["STARTER", "PRO"].includes(plan) || !["monthly", "annual"].includes(interval)) {
    redirect("/settings/billing");
  }
  const result = await startPlanChange(ctx, plan, interval);
  if (result.kind === "refused") redirect(`/settings/billing?status=${result.reason}`);
  redirect(result.url);
}

export async function openPortalAction(): Promise<void> {
  const [{ requirePermission }, { unscopedPrisma }, { createPortalSession }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/db/tenant"),
    import("@/server/integrations/stripe"),
  ]);

  const ctx = await requirePermission("billing:manage");
  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { stripeCustomerId: true },
  });
  if (!org.stripeCustomerId) redirect("/settings/billing");
  const url = await createPortalSession(org.stripeCustomerId);
  redirect(url);
}
