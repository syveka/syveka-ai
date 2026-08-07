import "server-only";

import Stripe from "stripe";
import type { Plan } from "@prisma/client";
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

  const customer = await getStripe().customers.create({
    name: params.orgName,
    email: params.email,
    metadata: { orgId: params.orgId },
  });
  return customer.id;
}

export async function createCheckoutSession(params: {
  customerId: string;
  orgId: string;
  plan: Plan;
  interval: BillingInterval;
  seats: number;
  locale: string;
}): Promise<string> {
  const { NEXT_PUBLIC_APP_URL } = getStripeEnv();
  const session = await getStripe().checkout.sessions.create({
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
    metadata: { orgId: params.orgId },
  });
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
