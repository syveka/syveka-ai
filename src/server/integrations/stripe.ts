import "server-only";

import Stripe from "stripe";
import type { Plan } from "@/generated/prisma/client/client";
import { getStripeEnv } from "@/env";

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    const { STRIPE_SECRET_KEY, NEXT_PUBLIC_APP_URL } = getStripeEnv();
    stripeClient = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-02-24.acacia",
      typescript: true,
      appInfo: { name: "Syveka AI", url: NEXT_PUBLIC_APP_URL },
    });
  }
  return stripeClient;
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop: keyof Stripe) {
    const client = getStripe();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export type BillingInterval = "monthly" | "annual";

function priceMap(): Record<Exclude<Plan, "FREE" | "ENTERPRISE">, Record<BillingInterval, string>> {
  const {
    STRIPE_PRICE_STARTER_MONTHLY,
    STRIPE_PRICE_STARTER_ANNUAL,
    STRIPE_PRICE_PRO_MONTHLY,
    STRIPE_PRICE_PRO_ANNUAL,
  } = getStripeEnv();
  return {
    STARTER: {
      monthly: STRIPE_PRICE_STARTER_MONTHLY,
      annual: STRIPE_PRICE_STARTER_ANNUAL,
    },
    PRO: {
      monthly: STRIPE_PRICE_PRO_MONTHLY,
      annual: STRIPE_PRICE_PRO_ANNUAL,
    },
  };
}

export function priceIdFor(plan: Plan, interval: BillingInterval): string {
  if (plan === "FREE" || plan === "ENTERPRISE") {
    throw new Error(`No self-serve price for plan ${plan}`);
  }
  return priceMap()[plan][interval];
}

/** Reverse lookup: Stripe price id → Plan (webhook handling, §14.4). */
export function planForPriceId(priceId: string): Plan | null {
  for (const [plan, prices] of Object.entries(priceMap()) as Array<
    [Plan, Record<BillingInterval, string>]
  >) {
    if (Object.values(prices).includes(priceId)) return plan;
  }
  return null;
}

export async function getOrCreateCustomer(params: {
  orgId: string;
  orgName: string;
  email: string;
  existingCustomerId?: string | null;
}): Promise<string> {
  if (params.existingCustomerId) return params.existingCustomerId;

  // One idempotency key per organization: two requests that both find no
  // stored customer (two tabs, a retry) get the same Stripe customer back
  // instead of creating two. Stripe keeps keys for 24 hours.
  const customer = await getStripe().customers.create(
    {
      name: params.orgName,
      email: params.email,
      metadata: { orgId: params.orgId },
    },
    { idempotencyKey: `org-customer:${params.orgId}` },
  );
  return customer.id;
}

/**
 * Stripe statuses of a subscription that still exists for billing: paying,
 * trialing, behind on payment, awaiting its first payment, or paused. Any of
 * these means a plan change must go through that subscription, not a new
 * Checkout.
 */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

/** Whether Stripe itself (not our webhook-fed copy) holds a live subscription for the customer. */
export async function hasLiveSubscription(customerId: string): Promise<boolean> {
  const subs = await getStripe().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });
  return subs.data.some((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status));
}

/**
 * At most one open Checkout per organization: reuses an open session for the
 * same plan and interval, and expires every other open one, so two tabs can't
 * each complete a Checkout and leave the customer with two subscriptions.
 * Returns the reusable session's URL, if any.
 */
export async function settleOpenCheckoutSessions(params: {
  customerId: string;
  orgId: string;
  plan: Plan;
  interval: BillingInterval;
}): Promise<string | null> {
  const open = await getStripe().checkout.sessions.list({
    customer: params.customerId,
    status: "open",
    limit: 20,
  });
  let reusable: string | null = null;
  for (const session of open.data) {
    const matches =
      session.metadata?.orgId === params.orgId &&
      session.metadata?.plan === params.plan &&
      session.metadata?.interval === params.interval &&
      session.url;
    if (matches && !reusable) {
      reusable = session.url;
    } else {
      await getStripe().checkout.sessions.expire(session.id);
    }
  }
  return reusable;
}

export async function createCheckoutSession(params: {
  customerId: string;
  orgId: string;
  plan: Plan;
  interval: BillingInterval;
  seats: number;
  locale: string;
  /** Stable for one attempt, so an SDK-level retry of it creates one session. */
  idempotencyKey: string;
}): Promise<string> {
  const { NEXT_PUBLIC_APP_URL } = getStripeEnv();
  const session = await getStripe().checkout.sessions.create(
    {
      customer: params.customerId,
      mode: "subscription",
      line_items: [{ price: priceIdFor(params.plan, params.interval), quantity: params.seats }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true }, // ALV-tunnus / EU VAT (§14.4)
      customer_update: { address: "auto", name: "auto" },
      locale: (["fi", "en"].includes(params.locale)
        ? params.locale
        : "auto") as Stripe.Checkout.SessionCreateParams.Locale,
      subscription_data: { metadata: { orgId: params.orgId } },
      success_url: `${NEXT_PUBLIC_APP_URL}/settings/billing?status=success`,
      cancel_url: `${NEXT_PUBLIC_APP_URL}/settings/billing?status=canceled`,
      metadata: { orgId: params.orgId, plan: params.plan, interval: params.interval },
    },
    { idempotencyKey: params.idempotencyKey },
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

export async function createPortalSession(customerId: string): Promise<string> {
  const { NEXT_PUBLIC_APP_URL } = getStripeEnv();
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${NEXT_PUBLIC_APP_URL}/settings/billing`,
  });
  return session.url;
}
