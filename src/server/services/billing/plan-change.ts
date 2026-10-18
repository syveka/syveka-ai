import "server-only";

import { randomUUID } from "node:crypto";
import type { Plan } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { redis } from "@/server/integrations/redis";
import {
  createCheckoutSession,
  createPortalSession,
  getOrCreateCustomer,
  hasLiveSubscription,
  settleOpenCheckoutSessions,
  type BillingInterval,
} from "@/server/integrations/stripe";
import { actionRateLimitError } from "@/server/security/rate-limit";
import type { TenantContext } from "@/server/auth/session";
import { audit } from "../audit";

/** Where a plan choice sends the member, or why it can't go anywhere right now. */
export type PlanChangeResult =
  | { kind: "checkout"; url: string }
  | { kind: "portal"; url: string }
  | { kind: "refused"; reason: "busy" | "unavailable" };

/** Our webhook-fed statuses that mean the org still has a subscription to change. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
  "INCOMPLETE",
  "PAUSED",
]);

const LOCK_TTL_SECONDS = 30;
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function lockKey(orgId: string): string {
  return `billing:plan-change:${orgId}`;
}

/**
 * A short per-organization claim, so two tabs or a double click can't run
 * the checks below at the same time and both decide to open a Checkout.
 * Fails closed: a Redis error is "unavailable", never a run without the lock.
 */
async function claim(orgId: string): Promise<{ token: string } | "busy" | "unavailable"> {
  const token = randomUUID();
  try {
    const set = await redis.set(lockKey(orgId), token, { nx: true, ex: LOCK_TTL_SECONDS });
    return set === null ? "busy" : { token };
  } catch {
    return "unavailable";
  }
}

async function release(orgId: string, token: string): Promise<void> {
  // Only our own claim; one that already expired and was taken by another
  // request is left alone. A failure here just lets the claim expire.
  await redis.eval(RELEASE_SCRIPT, [lockKey(orgId)], [token]).catch(() => undefined);
}

/**
 * Starts a paid plan for an organization without one, or sends an
 * organization that already has a subscription (paying, trialing, past due,
 * awaiting its first payment, or paused) to the Stripe Billing Portal, which
 * changes that same subscription instead of creating a second one.
 *
 * Order, all under the per-org claim:
 * 1. our stored subscription says it exists → portal;
 * 2. the Stripe customer, created once per org (idempotency key) and stored
 *    only if none is stored yet (a lost race uses the winner's);
 * 3. Stripe itself says a live subscription exists (covers a webhook that
 *    hasn't arrived yet) → portal;
 * 4. an open Checkout for the same plan and interval is reused; other open
 *    ones are expired, so only one can ever complete;
 * 5. a new Checkout, with an idempotency key for this attempt.
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

  const claimed = await claim(ctx.orgId);
  if (claimed === "busy" || claimed === "unavailable") return { kind: "refused", reason: claimed };

  try {
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
      return { kind: "portal", url: await createPortalSession(org.stripeCustomerId) };
    }

    let customerId = org.stripeCustomerId;
    if (!customerId) {
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
      customerId =
        stored.count === 1
          ? created
          : ((
              await unscopedPrisma.organization.findUniqueOrThrow({
                where: { id: ctx.orgId },
                select: { stripeCustomerId: true },
              })
            ).stripeCustomerId ?? created);
    }

    if (await hasLiveSubscription(customerId)) {
      return { kind: "portal", url: await createPortalSession(customerId) };
    }

    const reusable = await settleOpenCheckoutSessions({
      customerId,
      orgId: ctx.orgId,
      plan,
      interval,
    });
    if (reusable) return { kind: "checkout", url: reusable };

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
      seats: Math.max(1, org._count.members),
      locale: ctx.locale,
      idempotencyKey: `checkout:${ctx.orgId}:${claimed.token}`,
    });
    return { kind: "checkout", url };
  } finally {
    await release(ctx.orgId, claimed.token);
  }
}
