import { NextResponse } from "next/server";
import type Stripe from "stripe";
import type { unscopedPrisma as prismaClient } from "@/server/db/tenant";
import type { planForPriceId as resolvePlanForPriceId } from "@/server/integrations/stripe";
import type { invalidateEntitlements as invalidateBillingEntitlements } from "@/server/services/billing/entitlements";

export const runtime = "nodejs"; // raw-body signature verification
export const dynamic = "force-dynamic";

const SUB_STATUS_MAP: Record<Stripe.Subscription.Status, string> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  incomplete: "INCOMPLETE",
  incomplete_expired: "CANCELED",
  unpaid: "PAST_DUE",
  paused: "PAUSED",
};

type RuntimeDeps = {
  planForPriceId: typeof resolvePlanForPriceId;
  unscopedPrisma: typeof prismaClient;
  invalidateEntitlements: typeof invalidateBillingEntitlements;
};

async function upsertSubscription(sub: Stripe.Subscription, deps: RuntimeDeps): Promise<void> {
  const orgId = sub.metadata.orgId;
  if (!orgId) throw new Error(`Subscription ${sub.id} missing orgId metadata`);

  const item = sub.items.data[0];
  const priceId = item?.price.id ?? "";
  const plan = deps.planForPriceId(priceId);

  await deps.unscopedPrisma.subscription.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      stripeSubscriptionId: sub.id,
      plan: plan ?? "FREE",
      status: SUB_STATUS_MAP[sub.status] as never,
      seats: item?.quantity ?? 1,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    },
    update: {
      stripeSubscriptionId: sub.id,
      ...(plan ? { plan } : {}),
      status: SUB_STATUS_MAP[sub.status] as never,
      seats: item?.quantity ?? 1,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    },
  });
  await deps.invalidateEntitlements(orgId);
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const [
    { env },
    { stripe, planForPriceId },
    { unscopedPrisma },
    { invalidateEntitlements },
    { redis },
  ] = await Promise.all([
    import("@/env"),
    import("@/server/integrations/stripe"),
    import("@/server/db/tenant"),
    import("@/server/services/billing/entitlements"),
    import("@/server/integrations/redis"),
  ]);
  const deps = { planForPriceId, unscopedPrisma, invalidateEntitlements };

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  // Idempotency: Stripe retries; process each event once (§14.4)
  const dedupe = await redis.set(`stripe:evt:${event.id}`, "1", { nx: true, ex: 86_400 });
  if (dedupe === null) return NextResponse.json({ received: true, duplicate: true });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription && session.metadata?.orgId) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          if (!sub.metadata.orgId) {
            await stripe.subscriptions.update(sub.id, {
              metadata: { orgId: session.metadata.orgId },
            });
            sub.metadata.orgId = session.metadata.orgId;
          }
          await upsertSubscription(sub, deps);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await upsertSubscription(event.data.object, deps);
        break;

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const orgId = sub.metadata.orgId;
        if (orgId) {
          // Downgrade to FREE; data kept, over-limit features go read-only (§14.4)
          await deps.unscopedPrisma.subscription.update({
            where: { organizationId: orgId },
            data: { plan: "FREE", status: "CANCELED", stripeSubscriptionId: null },
          });
          await deps.invalidateEntitlements(orgId);
        }
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object;
        const subId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertSubscription(sub, deps); // clears PAST_DUE
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const org = await deps.unscopedPrisma.organization.findUnique({
            where: { stripeCustomerId: customerId },
            select: { id: true },
          });
          if (org) {
            await deps.unscopedPrisma.subscription.update({
              where: { organizationId: org.id },
              data: { status: "PAST_DUE" },
            });
            await deps.invalidateEntitlements(org.id);
            // Dunning email sequence is triggered by the billing service (day 0/3/7).
          }
        }
        break;
      }
      default:
        break; // unhandled event types are acknowledged
    }
  } catch (err) {
    console.error(`stripe webhook ${event.type} failed`, err);
    // 500 → Stripe retries with backoff (§14.4)
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
