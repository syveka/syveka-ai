import type { Plan } from "@/generated/prisma/client/client";

/**
 * Plan catalog: the one place plan limits and displayed list prices are
 * defined. Entitlement checks (src/server/services/billing/plans.ts), the
 * public pricing page and the in-app plan cards all read from here, so a
 * pricing change is made once.
 *
 * Displayed prices are not what a customer is charged: Stripe charges the
 * price ids in STRIPE_PRICE_* (src/server/integrations/stripe.ts). Change
 * both together.
 */

export type PlanLimits = {
  maxSeats: number;
  /**
   * AI messages per month for the whole organization: one shared pool,
   * never multiplied by members or seats.
   */
  aiMessagesPerOrgMonth: number;
  voiceAssistants: number;
  voiceMinutesMonth: number;
  kbStorageMb: number;
  activeWorkflows: number;
  maxContacts: number;
  apiAccess: boolean;
  auditRetentionDays: number;
  /** Monthly Creator Studio credit grant (§ creator-credits). */
  creatorCreditsPerMonth: number;
};

/** Plan matrix (§14.1). Single source of truth for entitlements. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    maxSeats: 2,
    aiMessagesPerOrgMonth: 50,
    voiceAssistants: 0,
    voiceMinutesMonth: 0,
    kbStorageMb: 50,
    activeWorkflows: 0,
    maxContacts: 200,
    apiAccess: false,
    auditRetentionDays: 0,
    creatorCreditsPerMonth: 0,
  },
  STARTER: {
    maxSeats: 10,
    aiMessagesPerOrgMonth: 1_000,
    voiceAssistants: 1,
    voiceMinutesMonth: 100,
    kbStorageMb: 1_024,
    activeWorkflows: 5,
    maxContacts: 5_000,
    apiAccess: false,
    auditRetentionDays: 30,
    creatorCreditsPerMonth: 200,
  },
  PRO: {
    maxSeats: 50,
    aiMessagesPerOrgMonth: 5_000,
    voiceAssistants: 3,
    voiceMinutesMonth: 500,
    kbStorageMb: 10_240,
    activeWorkflows: 25,
    maxContacts: 50_000,
    apiAccess: true,
    auditRetentionDays: 730,
    creatorCreditsPerMonth: 1_000,
  },
  ENTERPRISE: {
    maxSeats: Number.MAX_SAFE_INTEGER,
    aiMessagesPerOrgMonth: Number.MAX_SAFE_INTEGER,
    voiceAssistants: Number.MAX_SAFE_INTEGER,
    voiceMinutesMonth: Number.MAX_SAFE_INTEGER,
    kbStorageMb: Number.MAX_SAFE_INTEGER,
    activeWorkflows: Number.MAX_SAFE_INTEGER,
    maxContacts: Number.MAX_SAFE_INTEGER,
    apiAccess: true,
    auditRetentionDays: 730,
    creatorCreditsPerMonth: 5_000,
  },
};

/** Plans a customer can buy without sales; each has STRIPE_PRICE_* ids. */
export const SELF_SERVE_PLANS = ["STARTER", "PRO"] as const;
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];

/** Plans on the public pricing page, in display order. Enterprise is contact-sales. */
export const PUBLIC_PLANS = ["FREE", "STARTER", "PRO"] as const;
export type PublicPlan = (typeof PUBLIC_PLANS)[number];

/** Displayed list price, EUR per seat per month, excluding VAT. */
export const PLAN_MONTHLY_PRICE_EUR: Record<PublicPlan, number> = {
  FREE: 0,
  STARTER: 29,
  PRO: 79,
};

/** Annual billing charges this many months per year ("2 months free"). */
export const ANNUAL_BILLED_MONTHS = 10;

/** The plan the public pricing page highlights. */
export const HIGHLIGHTED_PLAN: PublicPlan = "PRO";

/** Which optional limits each in-app plan card lists (a display choice). */
export const PLAN_CARD_EXTRAS: Record<
  SelfServePlan,
  { contacts: boolean; apiWebhooks: boolean; auditRetention: boolean }
> = {
  STARTER: { contacts: true, apiWebhooks: false, auditRetention: false },
  // apiWebhooks stays off until a public API exists (no route accepts API keys).
  PRO: { contacts: false, apiWebhooks: false, auditRetention: true },
};

/** Displayed price per seat per month for a billing interval, rounded to whole euros. */
export function displayedMonthlyPriceEur(plan: PublicPlan, interval: "monthly" | "annual"): number {
  const monthly = PLAN_MONTHLY_PRICE_EUR[plan];
  return interval === "annual" ? Math.round((monthly * ANNUAL_BILLED_MONTHS) / 12) : monthly;
}
