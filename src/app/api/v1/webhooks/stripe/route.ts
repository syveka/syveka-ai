import { NextResponse } from "next/server";
import { sanitizeErrorMessage as sanitizeErrorMessageShared } from "@/server/security/error-sanitization";
import type Stripe from "stripe";
import type { Prisma } from "@/generated/prisma/client/client";
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

function customerIdOf(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
}

/** Stripe statuses of a subscription that is paying (or in its trial). */
const PAYING_STRIPE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);
/** Our stored statuses of a current subscription that pays nothing and can be superseded. */
const SUPERSEDABLE_BY_PAYING: ReadonlySet<string> = new Set(["CANCELED", "INCOMPLETE"]);

/** Structured, non-sensitive alert: ids and statuses only, never customer data. */
function alertSkippedSubscription(fields: Record<string, string | null>): void {
  console.warn(JSON.stringify({ alert: "stripe_subscription_event_skipped", ...fields }));
}

/**
 * Whether `sub` may be written as the organization's current subscription.
 * The org has one row, so an event for any other subscription -- an older
 * one still being retired, a stale retry, a second checkout -- replaces it
 * only when the current one doesn't pay:
 * - no current subscription, or the same one: yes;
 * - the current one has ended (CANCELED): yes;
 * - the current one is INCOMPLETE (its first payment never went through) and
 *   `sub` is ACTIVE or TRIALING: yes, the paying one takes over;
 * - otherwise (the current one is ACTIVE, TRIALING, PAST_DUE or PAUSED, or
 *   `sub` itself isn't paying): no. A live `sub` skipped this way raises a
 *   structured alert, since the customer may be paying for two.
 * A subscription whose customer isn't the org's own Stripe customer never
 * touches it, whatever its metadata says. `sub` is Stripe's current state,
 * retrieved by the caller, so its status isn't a stale event copy.
 */
async function mayBecomeCurrent(
  tx: Prisma.TransactionClient,
  orgId: string,
  sub: Stripe.Subscription,
): Promise<boolean> {
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { stripeCustomerId: true },
  });
  if (!org) return false;
  // Ownership is proven only by the org's stored Stripe customer, which
  // startCheckoutAction persists before any Checkout session exists. No
  // stored customer, or a subscription without one, proves nothing, so the
  // event is skipped (fail closed) rather than trusted on its metadata.
  const customerId = customerIdOf(sub);
  if (!org.stripeCustomerId || !customerId || org.stripeCustomerId !== customerId) {
    alertSkippedSubscription({
      reason: "customer_mismatch",
      organizationId: orgId,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
    });
    return false;
  }

  const current = await tx.subscription.findUnique({
    where: { organizationId: orgId },
    select: { stripeSubscriptionId: true, status: true },
  });
  if (!current?.stripeSubscriptionId || current.stripeSubscriptionId === sub.id) return true;
  if (current.status === "CANCELED") return true;
  if (PAYING_STRIPE_STATUSES.has(sub.status) && SUPERSEDABLE_BY_PAYING.has(current.status)) {
    return true;
  }
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") {
    alertSkippedSubscription({
      reason: "other_subscription_current",
      organizationId: orgId,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentSubscriptionId: current.stripeSubscriptionId,
      currentStatus: current.status,
    });
  }
  return false;
}

/**
 * Runs inside the caller's transaction -- no external (Stripe API) calls here.
 * Returns the org id, and whether the subscription was written (see
 * mayBecomeCurrent); a skipped event is still completed, never retried.
 */
async function applySubscriptionUpsert(
  tx: Prisma.TransactionClient,
  sub: Stripe.Subscription,
  deps: RuntimeDeps,
): Promise<{ orgId: string; applied: boolean }> {
  const orgId = sub.metadata.orgId;
  if (!orgId) throw new Error(`Subscription ${sub.id} missing orgId metadata`);
  if (!(await mayBecomeCurrent(tx, orgId, sub))) return { orgId, applied: false };

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
  return { orgId, applied: true };
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
            ({ orgId: resolvedOrgId } = await applySubscriptionUpsert(tx, sub, deps));
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
        // Stripe neither orders events nor stops retrying failed deliveries, so
        // this event's copy may be older than state already applied (e.g. an
        // "active" update retried after customer.subscription.deleted would
        // restore a paid plan). Apply the subscription's current state instead
        // -- fetched before the transaction opens, as for invoice.paid.
        const sub = await stripe.subscriptions.retrieve(event.data.object.id);
        if (sub.status === "canceled") {
          // customer.subscription.deleted owns the downgrade; a stale update
          // must neither revive nor downgrade anything on its own.
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, sub.id);
          break;
        }
        await unscopedPrisma.$transaction(async (tx) => {
          ({ orgId: resolvedOrgId } = await applySubscriptionUpsert(tx, sub, deps));
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
            // Downgrade to FREE; data kept, over-limit features go read-only (§14.4).
            // Only when the deleted subscription is the org's current one: ending
            // an older or second subscription must not downgrade an org that is
            // still paying through another. No row to match is a no-op, not a
            // failure Stripe would retry forever.
            await tx.subscription.updateMany({
              where: { organizationId: orgId, stripeSubscriptionId: sub.id },
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
            ({ orgId: resolvedOrgId } = await applySubscriptionUpsert(tx, sub, deps)); // clears PAST_DUE
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
        const failedSubId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id;
        if (!failedSubId) {
          // A one-off invoice belongs to no subscription, so it can't make
          // the org's subscription PAST_DUE.
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, invoice.id ?? null);
          break;
        }
        // Same ordering hazard as subscription updates: a retried failure
        // delivered after invoice.paid must not mark a paid-up subscription
        // PAST_DUE. Only act while Stripe still reports an ESTABLISHED
        // subscription as unpaid. An `incomplete` one never paid: its first
        // invoice failing is not dunning, and PAST_DUE would keep the paid
        // plan's limits (entitlements) and block a later paying subscription
        // from becoming current (mayBecomeCurrent). It stays INCOMPLETE until
        // it pays (invoice.paid) or expires (incomplete_expired).
        const current = await stripe.subscriptions.retrieve(failedSubId);
        if (!["past_due", "unpaid"].includes(current.status)) {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, invoice.id ?? null);
          break;
        }
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
            // Only the subscription this invoice is for: a failure on an
            // older or second subscription leaves the current one alone.
            await tx.subscription.updateMany({
              where: { organizationId: org.id, stripeSubscriptionId: failedSubId },
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
