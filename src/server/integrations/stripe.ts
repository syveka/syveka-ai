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

/**
 * Every billing call the plan-change flow makes (checkout, portal, payment)
 * is bounded, so the per-organization claim can always outlast one call:
 * - the SDK's own timeout, with no automatic retry: a retry could wait up to
 *   60 seconds for Stripe's Retry-After;
 * - a hard local deadline on top, because the SDK's timeout (Node) only
 *   fires when the socket goes idle, not on a slow, trickling response.
 * A call that hits the deadline fails with StripeCallTimeoutError. Stripe
 * may still finish it: callers never hand out a URL they didn't receive, and
 * the Checkout sweep in plan-change.ts deals with whatever was created.
 */
export const STRIPE_BILLING_CALL_TIMEOUT_MS = 10_000;
/** The longest a bounded call can keep its caller waiting. */
export const STRIPE_BILLING_CALL_HARD_LIMIT_MS = STRIPE_BILLING_CALL_TIMEOUT_MS + 2_000;

const BOUNDED_REQUEST: Stripe.RequestOptions = {
  timeout: STRIPE_BILLING_CALL_TIMEOUT_MS,
  maxNetworkRetries: 0,
};

export class StripeCallTimeoutError extends Error {
  constructor() {
    super("stripe_call_timeout");
    this.name = "StripeCallTimeoutError";
  }
}

async function bounded<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StripeCallTimeoutError()),
          STRIPE_BILLING_CALL_HARD_LIMIT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const customer = await bounded(
    getStripe().customers.create(
      {
        name: params.orgName,
        email: params.email,
        metadata: { orgId: params.orgId },
      },
      { ...BOUNDED_REQUEST, idempotencyKey: `org-customer:${params.orgId}` },
    ),
  );
  return customer.id;
}

/**
 * Stripe statuses of a subscription that still exists for billing, most
 * established first: paying, trialing, behind on payment, paused, or
 * awaiting its first payment. Any of these means a plan change must go
 * through that subscription, not a new Checkout.
 */
const LIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
] as const;

export type LiveSubscription = {
  id: string;
  status: (typeof LIVE_SUBSCRIPTION_STATUSES)[number];
};

/**
 * The customer's live subscription according to Stripe itself (not our
 * webhook-fed copy), or null. With several, the most established one.
 */
export async function findLiveSubscription(customerId: string): Promise<LiveSubscription | null> {
  const subs = await bounded(
    getStripe().subscriptions.list(
      { customer: customerId, status: "all", limit: 20 },
      BOUNDED_REQUEST,
    ),
  );
  for (const status of LIVE_SUBSCRIPTION_STATUSES) {
    const sub = subs.data.find((s) => s.status === status);
    if (sub) return { id: sub.id, status };
  }
  return null;
}

/**
 * Where to pay a subscription that is waiting for its first payment: the
 * hosted page of its open latest invoice, or null when there is none.
 */
export async function pendingPaymentUrl(subscriptionId: string): Promise<string | null> {
  const sub = await bounded(
    getStripe().subscriptions.retrieve(
      subscriptionId,
      { expand: ["latest_invoice"] },
      BOUNDED_REQUEST,
    ),
  );
  const invoice = sub.latest_invoice;
  if (!invoice || typeof invoice === "string") return null;
  return invoice.status === "open" ? (invoice.hosted_invoice_url ?? null) : null;
}

export type OpenCheckoutSession = {
  id: string;
  url: string | null;
  /** Unix seconds. */
  created: number;
  /** Unix seconds. */
  expiresAt: number;
  metadata: Record<string, string>;
};

/** The customer's open Checkout sessions. */
export async function listOpenCheckoutSessions(customerId: string): Promise<OpenCheckoutSession[]> {
  const open = await bounded(
    getStripe().checkout.sessions.list(
      { customer: customerId, status: "open", limit: 20 },
      BOUNDED_REQUEST,
    ),
  );
  return open.data.map((s) => ({
    id: s.id,
    url: s.url,
    created: s.created,
    expiresAt: s.expires_at,
    metadata: (s.metadata ?? {}) as Record<string, string>,
  }));
}

/**
 * Expires an open Checkout session. When Stripe refuses, the session's
 * actual state decides: "expired" (already gone, fine), "complete" (it was
 * paid in the meantime) or "failed" (still open, or unknown).
 */
export async function expireCheckoutSession(
  sessionId: string,
): Promise<"expired" | "complete" | "failed"> {
  try {
    await bounded(getStripe().checkout.sessions.expire(sessionId, {}, BOUNDED_REQUEST));
    return "expired";
  } catch {
    try {
      const session = await bounded(
        getStripe().checkout.sessions.retrieve(sessionId, {}, BOUNDED_REQUEST),
      );
      if (session.status === "expired") return "expired";
      if (session.status === "complete") return "complete";
      return "failed";
    } catch {
      return "failed";
    }
  }
}

export async function createCheckoutSession(params: {
  customerId: string;
  orgId: string;
  plan: Plan;
  interval: BillingInterval;
  seats: number;
  locale: string;
  /** Stable for one attempt, so a replay of it returns the same session. */
  idempotencyKey: string;
}): Promise<OpenCheckoutSession & { url: string }> {
  const { NEXT_PUBLIC_APP_URL } = getStripeEnv();
  const priceId = priceIdFor(params.plan, params.interval);
  const session = await bounded(
    getStripe().checkout.sessions.create(
      {
        customer: params.customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: params.seats }],
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true }, // ALV-tunnus / EU VAT (§14.4)
        customer_update: { address: "auto", name: "auto" },
        locale: (["fi", "en"].includes(params.locale)
          ? params.locale
          : "auto") as Stripe.Checkout.SessionCreateParams.Locale,
        subscription_data: { metadata: { orgId: params.orgId } },
        success_url: `${NEXT_PUBLIC_APP_URL}/settings/billing?status=success`,
        cancel_url: `${NEXT_PUBLIC_APP_URL}/settings/billing?status=canceled`,
        // What a later attempt compares before reusing this session.
        metadata: {
          orgId: params.orgId,
          plan: params.plan,
          interval: params.interval,
          priceId,
          seats: String(params.seats),
        },
      },
      { ...BOUNDED_REQUEST, idempotencyKey: params.idempotencyKey },
    ),
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return {
    id: session.id,
    url: session.url,
    created: session.created,
    expiresAt: session.expires_at,
    metadata: (session.metadata ?? {}) as Record<string, string>,
  };
}

/**
 * A portal session's URL plus what identifies its setup: the portal
 * configuration Stripe applied (the default one when none is passed) and
 * whether it is live mode. Only the latter two are ever logged; the URL is a
 * customer's credential for the portal.
 */
export type PortalSession = { url: string; configurationId: string | null; livemode: boolean };

function portalSessionOf(session: Stripe.BillingPortal.Session): PortalSession {
  const configuration = session.configuration as string | { id: string } | null | undefined;
  return {
    url: session.url,
    configurationId:
      typeof configuration === "string" ? configuration : (configuration?.id ?? null),
    livemode: session.livemode === true,
  };
}

export async function createPortalSession(customerId: string): Promise<PortalSession> {
  const { NEXT_PUBLIC_APP_URL } = getStripeEnv();
  const session = await bounded(
    getStripe().billingPortal.sessions.create(
      {
        customer: customerId,
        return_url: `${NEXT_PUBLIC_APP_URL}/settings/billing`,
      },
      BOUNDED_REQUEST,
    ),
  );
  return portalSessionOf(session);
}

/** What a plan change needs to know about a subscription, read from Stripe itself. */
export type PlanChangeSubscription = {
  id: string;
  customerId: string | null;
  /** The orgId our Checkout put in the subscription's metadata, if any. */
  orgId: string | null;
  status: Stripe.Subscription.Status;
  /** A customer-requested cancellation is waiting for its date. */
  cancellationPending: boolean;
  /** A subscription schedule controls it; the portal can't change it then. */
  scheduled: boolean;
  collectionMethod: Stripe.Subscription.CollectionMethod;
  items: Array<{ id: string; priceId: string; quantity: number; metered: boolean }>;
};

export async function retrieveSubscriptionForPlanChange(
  subscriptionId: string,
): Promise<PlanChangeSubscription> {
  const sub = await bounded(
    getStripe().subscriptions.retrieve(subscriptionId, {}, BOUNDED_REQUEST),
  );
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
    orgId: sub.metadata?.orgId ?? null,
    status: sub.status,
    cancellationPending: sub.cancel_at_period_end === true || sub.cancel_at != null,
    scheduled: sub.schedule != null,
    collectionMethod: sub.collection_method,
    items: (sub.items?.data ?? []).map((item) => ({
      id: item.id,
      priceId: item.price.id,
      quantity: item.quantity ?? 1,
      metered: item.price.recurring?.usage_type === "metered",
    })),
  };
}

/**
 * A portal session that shows the customer one specific change to their
 * subscription (the item's new price, same quantity) for them to review and
 * confirm. Stripe shows the amounts, takes any payment and applies the
 * change; nothing changes unless the customer confirms. Stripe requires the
 * price to be in the portal configuration's subscription_update products,
 * and refuses the session otherwise.
 */
export async function createPlanChangePortalSession(params: {
  customerId: string;
  subscriptionId: string;
  itemId: string;
  priceId: string;
  quantity: number;
}): Promise<PortalSession> {
  const { NEXT_PUBLIC_APP_URL } = getStripeEnv();
  const session = await bounded(
    getStripe().billingPortal.sessions.create(
      {
        customer: params.customerId,
        return_url: `${NEXT_PUBLIC_APP_URL}/settings/billing`,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: params.subscriptionId,
            items: [{ id: params.itemId, price: params.priceId, quantity: params.quantity }],
          },
          after_completion: {
            type: "redirect",
            redirect: {
              return_url: `${NEXT_PUBLIC_APP_URL}/settings/billing?status=plan_change_submitted`,
            },
          },
        },
      },
      BOUNDED_REQUEST,
    ),
  );
  return portalSessionOf(session);
}

/**
 * Stripe's own reason for refusing a request (type, code and the parameter
 * it names), never its message or anything from the request.
 */
export function stripeRefusal(err: unknown): { type: string; code: string; param: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const { type, code, param } = err as { type?: unknown; code?: unknown; param?: unknown };
  if (type !== "StripeInvalidRequestError") return null;
  return {
    type,
    code: typeof code === "string" ? code : "none",
    param: typeof param === "string" ? param : "none",
  };
}
