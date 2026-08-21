import { NextResponse } from "next/server";
import { sanitizeErrorMessage as sanitizeErrorMessageShared } from "@/server/security/error-sanitization";
import type Stripe from "stripe";
import type { Prisma } from "@prisma/client";
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

/**
 * A claimed-but-never-completed row older than this is treated as
 * abandoned (crashed serverless execution, killed process) and becomes
 * eligible for reclaim by the next delivery/retry, rather than staying
 * stuck in PROCESSING forever. Comfortably longer than this route's
 * realistic worst-case runtime (a couple of Stripe API round-trips plus a
 * short DB transaction).
 */
const STALE_PROCESSING_MS = 5 * 60_000;

/** Truncated, URL-redacted error text -- never the raw Stripe payload or a stack trace. */
function sanitizeErrorMessage(err: unknown): string {
  return sanitizeErrorMessageShared(err, 500);
}

/** Best-effort (orgId, objectId) extraction for ledger observability only -- never used for auth. */
function describeEvent(event: Stripe.Event): { orgId: string | null; objectId: string | null } {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      return { orgId: session.metadata?.orgId ?? null, objectId: session.id };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      return { orgId: sub.metadata.orgId ?? null, objectId: sub.id };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return { orgId: null, objectId: invoice.id ?? null };
    }
    default:
      return { orgId: null, objectId: null };
  }
}

type RuntimeDeps = {
  planForPriceId: typeof resolvePlanForPriceId;
  invalidateEntitlements: typeof invalidateBillingEntitlements;
};

/** Runs inside the caller's transaction -- no external (Stripe API) calls here. */
async function applySubscriptionUpsert(
  tx: Prisma.TransactionClient,
  sub: Stripe.Subscription,
  deps: RuntimeDeps,
): Promise<string> {
  const orgId = sub.metadata.orgId;
  if (!orgId) throw new Error(`Subscription ${sub.id} missing orgId metadata`);

  const item = sub.items.data[0];
  const priceId = item?.price.id ?? "";
  const plan = deps.planForPriceId(priceId);

  await tx.subscription.upsert({
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
  return orgId;
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const [
    { getStripeEnv },
    { stripe, planForPriceId },
    { unscopedPrisma },
    { invalidateEntitlements },
  ] = await Promise.all([
    import("@/env"),
    import("@/server/integrations/stripe"),
    import("@/server/db/tenant"),
    import("@/server/services/billing/entitlements"),
  ]);
  const deps: RuntimeDeps = { planForPriceId, invalidateEntitlements };

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      getStripeEnv().STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const { orgId: describedOrgId, objectId } = describeEvent(event);

  // ── Durable idempotency ledger (§14.4) ──
  // Ensure a row exists for this Stripe event id. Two concurrent first
  // deliveries can both reach this block; exactly one `create()` wins, the
  // other hits the unique constraint on `stripe_event_id` and falls through
  // to re-read whatever the winner wrote -- there is no window where two
  // rows exist for the same event.
  let justCreated = false;
  try {
    await unscopedPrisma.stripeWebhookEvent.create({
      data: { stripeEventId: event.id, eventType: event.type, organizationId: describedOrgId },
    });
    justCreated = true;
  } catch (err) {
    const isUniqueViolation =
      typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
    if (!isUniqueViolation) {
      console.error(`stripe webhook ${event.type} ledger create failed`, sanitizeErrorMessage(err));
      return NextResponse.json({ error: "ledger unavailable" }, { status: 500 });
    }
  }

  // A row we just created ourselves is always fresh (RECEIVED, 0 attempts) --
  // no need to re-read it. Only an existing row (the create() lost to a
  // unique-constraint conflict) needs its current state inspected.
  if (!justCreated) {
    const existing = await unscopedPrisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (!existing) {
      // Row vanished between create/re-read (should not happen barring an
      // external delete) -- fail closed, retryable.
      return NextResponse.json({ error: "ledger unavailable" }, { status: 500 });
    }

    if (existing.status === "COMPLETED") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (existing.status === "PROCESSING") {
      const staleSince = Date.now() - STALE_PROCESSING_MS;
      const isStale = !existing.lastAttemptAt || existing.lastAttemptAt.getTime() < staleSince;
      if (!isStale) {
        // Another execution is actively handling this exact event right now.
        // Acknowledge without reprocessing; the stale-reclaim window above
        // covers the case where that execution never finishes.
        return NextResponse.json({ received: true, processing: true });
      }
    }
  }

  // Atomic claim: RECEIVED/FAILED are always retriable; a PROCESSING row is
  // only retriable once it is stale. This is a conditional UPDATE, not a
  // read-then-write -- Postgres row-level locking makes it safe against two
  // concurrent requests claiming the same row (exactly one `updateMany`
  // matches; the loser's `count` is 0).
  const claimed = await unscopedPrisma.stripeWebhookEvent.updateMany({
    where: {
      stripeEventId: event.id,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", lastAttemptAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
      ],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 }, lastAttemptAt: new Date() },
  });
  if (claimed.count === 0) {
    // Lost the race to another concurrent claim, or the event completed
    // between our read above and this claim attempt.
    const nowState = await unscopedPrisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
      select: { status: true },
    });
    if (nowState?.status === "COMPLETED") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json({ received: true, processing: true });
  }

  try {
    let resolvedOrgId: string | null = describedOrgId;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription && session.metadata?.orgId) {
          // Stripe API call happens before the DB transaction opens -- a
          // transaction must never hold a connection open across a network
          // round-trip to an external service.
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          if (!sub.metadata.orgId) {
            await stripe.subscriptions.update(sub.id, {
              metadata: { orgId: session.metadata.orgId },
            });
            sub.metadata.orgId = session.metadata.orgId;
          }
          await unscopedPrisma.$transaction(async (tx) => {
            resolvedOrgId = await applySubscriptionUpsert(tx, sub, deps);
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: resolvedOrgId,
                objectId: sub.id,
              },
            });
          });
          await invalidateEntitlements(resolvedOrgId!);
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        await unscopedPrisma.$transaction(async (tx) => {
          resolvedOrgId = await applySubscriptionUpsert(tx, sub, deps);
          await tx.stripeWebhookEvent.update({
            where: { stripeEventId: event.id },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              organizationId: resolvedOrgId,
              objectId: sub.id,
            },
          });
        });
        await invalidateEntitlements(resolvedOrgId!);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const orgId = sub.metadata.orgId;
        if (orgId) {
          await unscopedPrisma.$transaction(async (tx) => {
            // Downgrade to FREE; data kept, over-limit features go read-only (§14.4)
            await tx.subscription.update({
              where: { organizationId: orgId },
              data: { plan: "FREE", status: "CANCELED", stripeSubscriptionId: null },
            });
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: orgId,
                objectId: sub.id,
              },
            });
          });
          await invalidateEntitlements(orgId);
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
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
          await unscopedPrisma.$transaction(async (tx) => {
            resolvedOrgId = await applySubscriptionUpsert(tx, sub, deps); // clears PAST_DUE
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: resolvedOrgId,
                objectId: invoice.id ?? sub.id,
              },
            });
          });
          await invalidateEntitlements(resolvedOrgId!);
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        const org = customerId
          ? await unscopedPrisma.organization.findUnique({
              where: { stripeCustomerId: customerId },
              select: { id: true },
            })
          : null;
        if (org) {
          await unscopedPrisma.$transaction(async (tx) => {
            await tx.subscription.update({
              where: { organizationId: org.id },
              data: { status: "PAST_DUE" },
            });
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: org.id,
                objectId: invoice.id ?? null,
              },
            });
          });
          await invalidateEntitlements(org.id);
          // Dunning email sequence is triggered by the billing service (day 0/3/7).
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged and marked complete so we
        // never re-attempt them -- there is nothing to retry.
        await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        break;
    }
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    console.error(`stripe webhook ${event.type} failed`, message);
    await unscopedPrisma.stripeWebhookEvent
      .update({
        where: { stripeEventId: event.id },
        data: { status: "FAILED", lastError: message },
      })
      .catch((updateErr) => {
        console.error(
          "stripe webhook ledger FAILED-state write failed",
          sanitizeErrorMessage(updateErr),
        );
      });
    // 500 → Stripe retries with backoff (§14.4); the ledger row is now
    // FAILED, so the retry will be claimed and reprocessed, not skipped.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/** Marks a no-op (guard-condition-skipped or unhandled) event complete without a business mutation. */
async function markCompleted(
  db: typeof prismaClient,
  stripeEventId: string,
  organizationId: string | null,
  objectId: string | null,
): Promise<void> {
  await db.stripeWebhookEvent.update({
    where: { stripeEventId },
    data: { status: "COMPLETED", completedAt: new Date(), organizationId, objectId },
  });
}
