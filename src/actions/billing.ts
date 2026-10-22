"use server";

import { redirect } from "next/navigation";
import type { Plan } from "@/generated/prisma/client/client";

type BillingInterval = "monthly" | "annual";

/**
 * A plan choice from the plan cards. An organization without a subscription
 * gets a Checkout; one that already has a subscription goes to the Stripe
 * Billing Portal to change it, or to the payment page of one waiting for its
 * first payment (see startPlanChange). A refusal (busy, or the rate limit,
 * lock or Stripe can't be reached) returns to the billing page saying so.
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

/**
 * The "Manage" / "Complete payment" button: rate-limited, then the Billing
 * Portal, or the open first invoice of a subscription waiting for its first
 * payment (see openBillingPortal).
 */
export async function openPortalAction(): Promise<void> {
  const [{ requirePermission }, { openBillingPortal }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/billing/plan-change"),
  ]);

  const ctx = await requirePermission("billing:manage");
  const result = await openBillingPortal(ctx);
  if (!result) redirect("/settings/billing");
  if (result.kind === "refused") redirect(`/settings/billing?status=${result.reason}`);
  redirect(result.url);
}
