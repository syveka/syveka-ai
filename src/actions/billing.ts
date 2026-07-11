"use server";

import { redirect } from "next/navigation";
import type { Plan } from "@prisma/client";

type BillingInterval = "monthly" | "annual";

export async function startCheckoutAction(plan: Plan, interval: BillingInterval): Promise<void> {
  const [
    { requirePermission },
    { unscopedPrisma },
    { getOrCreateCustomer, createCheckoutSession },
    { audit },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/db/tenant"),
    import("@/server/integrations/stripe"),
    import("@/server/services/audit"),
  ]);

  const ctx = await requirePermission("billing:manage");

  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    include: { members: { select: { userId: true } } },
  });

  const customerId = await getOrCreateCustomer({
    orgId: ctx.orgId,
    orgName: org.name,
    email: ctx.email,
    existingCustomerId: org.stripeCustomerId,
  });
  if (customerId !== org.stripeCustomerId) {
    await unscopedPrisma.organization.update({
      where: { id: ctx.orgId },
      data: { stripeCustomerId: customerId },
    });
  }

  await audit(ctx, {
    action: "billing.checkout_started",
    resourceType: "subscription",
    after: { plan, interval },
  });

  const url = await createCheckoutSession({
    customerId,
    orgId: ctx.orgId,
    plan,
    interval,
    seats: Math.max(1, org.members.length),
    locale: ctx.locale,
  });
  redirect(url);
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
