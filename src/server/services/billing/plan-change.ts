import "server-only";

import { randomUUID } from "node:crypto";
import type { Plan } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { redis } from "@/server/integrations/redis";
import {
  createCheckoutSession,
  createPortalSession,
  expireCheckoutSession,
  findLiveSubscription,
  getOrCreateCustomer,
  listOpenCheckoutSessions,
  pendingPaymentUrl,
  priceIdFor,
  STRIPE_BILLING_CALL_HARD_LIMIT_MS,
  StripeCallTimeoutError,
  type BillingInterval,
  type OpenCheckoutSession,
} from "@/server/integrations/stripe";
import { actionRateLimitError } from "@/server/security/rate-limit";
import type { TenantContext } from "@/server/auth/session";
import { audit } from "../audit";

/** Where a billing choice sends the member, or why it can't go anywhere right now. */
export type PlanChangeResult =
  | { kind: "checkout"; url: string }
  | { kind: "portal"; url: string }
  /** A subscription waiting for its first payment: its hosted invoice page. */
  | { kind: "payment"; url: string }
  | { kind: "refused"; reason: "busy" | "unavailable" };

/** Our webhook-fed statuses that mean the org still has a subscription to change. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
  "INCOMPLETE",
  "PAUSED",
]);

/**
 * The claim is renewed (and its ownership checked) before every Stripe call
 * below, to this TTL. It safely exceeds the longest a single bounded call
 * can take, so the claim can't lapse during a call.
 */
const CLAIM_TTL_MS = 30_000;
/** The whole claimed section; past it, no new Stripe call (and no Checkout) is started. */
const CLAIM_BUDGET_MS = 60_000;
/** An open Checkout this close to Stripe's expiry isn't handed out again. */
const REUSE_MIN_REMAINING_SECONDS = 15 * 60;

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

if (CLAIM_TTL_MS <= 2 * STRIPE_BILLING_CALL_HARD_LIMIT_MS) {
  throw new Error("The plan-change claim must outlast a bounded Stripe call with margin");
}

function lockKey(orgId: string): string {
  return `billing:plan-change:${orgId}`;
}

class Refused extends Error {
  constructor(readonly reason: "busy" | "unavailable") {
    super(reason);
  }
}

type Claim = { token: string; startedAt: number };

/**
 * A per-organization claim, so two tabs or a double click can't run the
 * checks below at the same time and both decide to open a Checkout.
 * Fails closed: a Redis error is "unavailable", never a run without the lock.
 */
async function claim(orgId: string): Promise<Claim | "busy" | "unavailable"> {
  const token = randomUUID();
  try {
    const set = await redis.set(lockKey(orgId), token, { nx: true, px: CLAIM_TTL_MS });
    return set === null ? "busy" : { token, startedAt: Date.now() };
  } catch {
    return "unavailable";
  }
}

/**
 * Called right before every Stripe call made under the claim: confirms the
 * claim is still ours and extends it. Throws Refused when the claim was lost
 * ("busy"), Redis can't confirm it, or the section ran out of time
 * ("unavailable").
 */
async function renew(orgId: string, held: Claim): Promise<void> {
  if (Date.now() - held.startedAt > CLAIM_BUDGET_MS) throw new Refused("unavailable");
  let renewed: unknown;
  try {
    renewed = await redis.eval(RENEW_SCRIPT, [lockKey(orgId)], [held.token, String(CLAIM_TTL_MS)]);
  } catch {
    throw new Refused("unavailable");
  }
  if (renewed !== 1) throw new Refused("busy");
}

async function release(orgId: string, token: string): Promise<void> {
  // Only our own claim; one that already expired and was taken by another
  // request is left alone. A failure here just lets the claim expire.
  await redis.eval(RELEASE_SCRIPT, [lockKey(orgId)], [token]).catch(() => undefined);
}

/** Structured, non-sensitive billing event: ids and outcomes only, never names, emails or URLs. */
function logBillingEvent(event: string, fields: Record<string, string | number>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/** The oldest first; Stripe's `created` is in seconds, so ties are broken by id. */
function byAge(a: OpenCheckoutSession, b: OpenCheckoutSession): number {
  return a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Expires each session. A session paid in the meantime ("complete") means a
 * subscription is on its way, so no new Checkout may follow; one Stripe
 * wouldn't expire is a deliberate stop, never ignored.
 */
async function expireAll(
  orgId: string,
  sessions: OpenCheckoutSession[],
  beforeEachCall: () => Promise<void>,
): Promise<void> {
  for (const session of sessions) {
    await beforeEachCall();
    const outcome = await expireCheckoutSession(session.id);
    if (outcome === "expired") continue;
    logBillingEvent("billing_checkout_expire_failed", { orgId, sessionId: session.id, outcome });
    throw new Refused(outcome === "complete" ? "busy" : "unavailable");
  }
}

/**
 * For an organization with a subscription: its waiting-payment page when it
 * is waiting for its first payment and Stripe has an open invoice for it,
 * otherwise the Billing Portal, which changes that same subscription.
 */
async function existingSubscriptionDestination(
  customerId: string,
  awaitingFirstPaymentId: string | null,
): Promise<PlanChangeResult> {
  if (awaitingFirstPaymentId) {
    const url = await pendingPaymentUrl(awaitingFirstPaymentId);
    if (url) return { kind: "payment", url };
  }
  return { kind: "portal", url: await createPortalSession(customerId) };
}

/**
 * Starts a paid plan for an organization without one, or sends an
 * organization that already has a subscription (paying, trialing, past due,
 * awaiting its first payment, or paused) to change or pay that subscription,
 * instead of creating a second one.
 *
 * Order, under the per-org claim, renewed before every Stripe call:
 * 1. our stored subscription says it exists → portal (or its payment page);
 * 2. the Stripe customer, created once per org (idempotency key) and stored
 *    only if none is stored yet (a lost race uses the winner's and logs the
 *    other as an orphan);
 * 3. Stripe itself says a live subscription exists (covers a webhook that
 *    hasn't arrived yet) → portal (or its payment page);
 * 4. open Checkouts: one for the same org, price and seat count, not close
 *    to expiry, is reused; every other one is expired;
 * 5. a new Checkout, with an idempotency key for this attempt, created only
 *    after the claim is confirmed still ours;
 * 6. a sweep, so only one usable Checkout can survive even if two attempts
 *    overlapped anyway (see settleAfterCreate).
 */
export async function startPlanChange(
  ctx: Pick<TenantContext, "orgId" | "userId" | "email" | "locale">,
  plan: Plan,
  interval: BillingInterval,
): Promise<PlanChangeResult> {
  const limited = await actionRateLimitError(
    ["auth", `billing-plan-change:org:${ctx.orgId}`],
    ["auth", `billing-plan-change:user:${ctx.userId}`],
  );
  if (limited)
    return { kind: "refused", reason: limited === "rate_limited" ? "busy" : "unavailable" };

  const held = await claim(ctx.orgId);
  if (held === "busy" || held === "unavailable") return { kind: "refused", reason: held };

  try {
    return await underClaim(ctx, plan, interval, held);
  } catch (err) {
    if (err instanceof Refused) return { kind: "refused", reason: err.reason };
    if (err instanceof StripeCallTimeoutError) {
      // Nothing it might still create is handed out; the next attempt's
      // Checkout handling deals with it.
      logBillingEvent("billing_stripe_timeout", { orgId: ctx.orgId, step: "plan_change" });
      return { kind: "refused", reason: "unavailable" };
    }
    throw err;
  } finally {
    await release(ctx.orgId, held.token);
  }
}

async function underClaim(
  ctx: Pick<TenantContext, "orgId" | "userId" | "email" | "locale">,
  plan: Plan,
  interval: BillingInterval,
  held: Claim,
): Promise<PlanChangeResult> {
  const keep = () => renew(ctx.orgId, held);

  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: {
      name: true,
      stripeCustomerId: true,
      subscription: { select: { stripeSubscriptionId: true, status: true } },
      _count: { select: { members: true } },
    },
  });

  if (
    org.stripeCustomerId &&
    org.subscription?.stripeSubscriptionId &&
    LIVE_STATUSES.has(org.subscription.status)
  ) {
    await keep();
    return existingSubscriptionDestination(
      org.stripeCustomerId,
      org.subscription.status === "INCOMPLETE" ? org.subscription.stripeSubscriptionId : null,
    );
  }

  let customerId = org.stripeCustomerId;
  if (!customerId) {
    await keep();
    const created = await getOrCreateCustomer({
      orgId: ctx.orgId,
      orgName: org.name,
      email: ctx.email,
      existingCustomerId: null,
    });
    const stored = await unscopedPrisma.organization.updateMany({
      where: { id: ctx.orgId, stripeCustomerId: null },
      data: { stripeCustomerId: created },
    });
    if (stored.count === 1) {
      customerId = created;
    } else {
      const winner = (
        await unscopedPrisma.organization.findUniqueOrThrow({
          where: { id: ctx.orgId },
          select: { stripeCustomerId: true },
        })
      ).stripeCustomerId;
      customerId = winner ?? created;
      if (winner && winner !== created) {
        // Only possible when the per-org idempotency key didn't apply (for
        // example it was more than 24 hours old). The org keeps the stored
        // customer; this one has no subscription and is left for cleanup.
        logBillingEvent("billing_orphan_stripe_customer", {
          orgId: ctx.orgId,
          orphanCustomerId: created,
        });
      }
    }
  }

  await keep();
  const live = await findLiveSubscription(customerId);
  if (live) {
    await keep();
    return existingSubscriptionDestination(
      customerId,
      live.status === "incomplete" ? live.id : null,
    );
  }

  const seats = Math.max(1, org._count.members);
  const priceId = priceIdFor(plan, interval);
  const reusable = (s: OpenCheckoutSession) =>
    Boolean(s.url) &&
    s.metadata.orgId === ctx.orgId &&
    s.metadata.priceId === priceId &&
    s.metadata.seats === String(seats) &&
    s.expiresAt - Date.now() / 1000 > REUSE_MIN_REMAINING_SECONDS;

  await keep();
  const open = (await listOpenCheckoutSessions(customerId)).sort(byAge);
  const reuse = open.find(reusable);
  await expireAll(
    ctx.orgId,
    open.filter((s) => s !== reuse),
    keep,
  );
  if (reuse?.url) return { kind: "checkout", url: reuse.url };

  await audit(ctx, {
    action: "billing.checkout_started",
    resourceType: "subscription",
    after: { plan, interval },
  });
  // Immediately before the create: the claim must still be ours.
  await keep();
  const created = await createCheckoutSession({
    customerId,
    orgId: ctx.orgId,
    plan,
    interval,
    seats,
    locale: ctx.locale,
    idempotencyKey: `checkout:${ctx.orgId}:${held.token}`,
  });
  return settleAfterCreate(ctx.orgId, customerId, created, reusable);
}

/**
 * The guarantee that holds even if two attempts overlapped anyway (the claim
 * lost to a Redis failover, a request that outlived its claim): of the
 * customer's open Checkouts, the OLDEST one wins. Every attempt applies the
 * same rule after creating its own, so:
 * - an attempt whose session isn't the oldest expires its own and hands out
 *   the oldest one if it's for the same price and seats (otherwise it says
 *   busy);
 * - the oldest one's attempt expires every newer one.
 * So this sweep never expires a URL another attempt already handed out, and
 * at most one handed-out Checkout stays open. (Choosing another plan later
 * still replaces an earlier open Checkout on purpose, in step 4.)
 *
 * Runs regardless of the claim: it only expires sessions and never creates
 * one, so it is safe to run late.
 */
async function settleAfterCreate(
  orgId: string,
  customerId: string,
  mine: OpenCheckoutSession & { url: string },
  reusable: (s: OpenCheckoutSession) => boolean,
): Promise<PlanChangeResult> {
  let open: OpenCheckoutSession[];
  try {
    open = (await listOpenCheckoutSessions(customerId)).sort(byAge);
  } catch {
    // Can't see what else is open: don't hand ours out.
    await expireCheckoutSession(mine.id);
    logBillingEvent("billing_checkout_sweep_failed", { orgId, sessionId: mine.id });
    throw new Refused("unavailable");
  }
  const oldest = open[0];
  if (!open.some((s) => s.id === mine.id) || !oldest) {
    // Already expired by a concurrent attempt that chose another plan.
    throw new Refused("busy");
  }
  if (oldest.id !== mine.id) {
    await expireCheckoutSession(mine.id);
    if (reusable(oldest) && oldest.url) return { kind: "checkout", url: oldest.url };
    throw new Refused("busy");
  }
  try {
    // No claim check here: expiring is safe without it.
    await expireAll(
      orgId,
      open.filter((s) => s.id !== mine.id),
      async () => undefined,
    );
  } catch (err) {
    // A newer session we couldn't expire, or one that got paid: ours can't
    // safely be handed out next to it.
    await expireCheckoutSession(mine.id);
    throw err;
  }
  return { kind: "checkout", url: mine.url };
}

/**
 * The "Manage" / "Complete payment" button: rate-limited like plan changes,
 * then the subscription's waiting-payment page when it awaits its first
 * payment, otherwise the Billing Portal. Null when the org has no Stripe
 * customer yet (nothing to manage).
 */
export async function openBillingPortal(
  ctx: Pick<TenantContext, "orgId" | "userId">,
): Promise<PlanChangeResult | null> {
  const limited = await actionRateLimitError(
    ["auth", `billing-portal:org:${ctx.orgId}`],
    ["auth", `billing-portal:user:${ctx.userId}`],
  );
  if (limited)
    return { kind: "refused", reason: limited === "rate_limited" ? "busy" : "unavailable" };

  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: {
      stripeCustomerId: true,
      subscription: { select: { stripeSubscriptionId: true, status: true } },
    },
  });
  if (!org.stripeCustomerId) return null;
  const sub = org.subscription;
  try {
    return await existingSubscriptionDestination(
      org.stripeCustomerId,
      sub?.status === "INCOMPLETE" ? (sub.stripeSubscriptionId ?? null) : null,
    );
  } catch (err) {
    if (err instanceof StripeCallTimeoutError) {
      logBillingEvent("billing_stripe_timeout", { orgId: ctx.orgId, step: "portal" });
      return { kind: "refused", reason: "unavailable" };
    }
    throw err;
  }
}
