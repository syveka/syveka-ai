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
  aiMessagesPerUserMonth: number;
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
    aiMessagesPerUserMonth: 25, // 50 per org / 2 seats
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
    aiMessagesPerUserMonth: 1_000,
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
    aiMessagesPerUserMonth: 5_000,
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
    aiMessagesPerUserMonth: Number.MAX_SAFE_INTEGER,
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

/**
 * Plans whose AI messages are presented as one pooled monthly total
 * (allowance per user × seats) rather than per user.
 */
export const POOLED_AI_MESSAGE_PLANS: ReadonlySet<PublicPlan> = new Set(["FREE"]);

/** Which optional limits each in-app plan card lists (a display choice). */
export const PLAN_CARD_EXTRAS: Record<
  SelfServePlan,
  { contacts: boolean; apiWebhooks: boolean; auditRetention: boolean }
> = {
  STARTER: { contacts: true, apiWebhooks: false, auditRetention: false },
  PRO: { contacts: false, apiWebhooks: true, auditRetention: true },
};

/** Displayed price per seat per month for a billing interval, rounded to whole euros. */
export function displayedMonthlyPriceEur(plan: PublicPlan, interval: "monthly" | "annual"): number {
  const monthly = PLAN_MONTHLY_PRICE_EUR[plan];
  return interval === "annual" ? Math.round((monthly * ANNUAL_BILLED_MONTHS) / 12) : monthly;
}

/**
 * How extra seats are handled once a plan's included seats are used:
 * "none" (no extra seats can be bought), "paid" (each extra seat is billed),
 * or "custom" (set by contract).
 */
export type ExtraSeatPolicy = "none" | "paid" | "custom";

/**
 * Target seat model: included seats + paid extra seats. Read only by
 * computeSeatBilling() and reconcileSeatBilling()
 * (src/server/services/billing/seats.ts). Nothing is charged for extra seats
 * until their Stripe prices and a proration policy are approved; seat limits
 * are still enforced by PLAN_LIMITS[plan].maxSeats.
 */
export const SEAT_BILLING_POLICY: Record<
  Plan,
  { includedSeats: number; extraSeats: ExtraSeatPolicy }
> = {
  FREE: { includedSeats: 1, extraSeats: "none" },
  STARTER: { includedSeats: 2, extraSeats: "paid" },
  PRO: { includedSeats: 5, extraSeats: "paid" },
  ENTERPRISE: { includedSeats: 0, extraSeats: "custom" },
};
