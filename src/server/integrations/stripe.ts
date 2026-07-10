import "server-only";

import Stripe from "stripe";
import type { Plan } from "@prisma/client";
import { env } from "@/env";

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
  typescript: true,
  appInfo: { name: "Syveka AI", url: env.NEXT_PUBLIC_APP_URL },
});

export type BillingInterval = "monthly" | "annual";

const PRICE_MAP: Record<Exclude<Plan, "FREE" | "ENTERPRISE">, Record<BillingInterval, string>> = {
  STARTER: {
    monthly: env.STRIPE_PRICE_STARTER_MONTHLY,
    annual: env.STRIPE_PRICE_STARTER_ANNUAL,
  },
  PRO: {
    monthly: env.STRIPE_PRICE_PRO_MONTHLY,
    annual: env.STRIPE_PRICE_PRO_ANNUAL,
  },
};

export function priceIdFor(plan: Plan, interval: BillingInterval): string {
  if (plan === "FREE" || plan === "ENTERPRISE") {
    throw new Error(`No self-serve price for plan ${plan}`);
  }
  return PRICE_MAP[plan][interval];
}

/** Reverse lookup: Stripe price id → Plan (webhook handling, §14.4). */
export function planForPriceId(priceId: string): Plan | null {
  for (const [plan, prices] of Object.entries(PRICE_MAP) as Array<
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

  const customer = await stripe.customers.create({
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
  const session = await stripe.checkout.sessions.create({
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
    success_url: `${env.NEXT_PUBLIC_APP_URL}/settings/billing?status=success`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/settings/billing?status=canceled`,
    metadata: { orgId: params.orgId },
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

export async function createPortalSession(customerId: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.NEXT_PUBLIC_APP_URL}/settings/billing`,
  });
  return session.url;
}
