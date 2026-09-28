import type { Plan } from "@/generated/prisma/client/client";

/**
 * Plan names are product names and stay untranslated (same policy as the
 * public pricing page, src/app/[locale]/(marketing)/pricing/page.tsx); the
 * canonical `Plan` enum value is never shown to users.
 */
export const PLAN_NAMES: Record<Plan, string> = {
  FREE: "Free",
  STARTER: "Starter",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
};

/**
 * Locale-aware counts with Latin digits in Arabic, matching the pricing page
 * (`ar-u-nu-latn`), so plan numbers read the same everywhere.
 */
export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : locale).format(value);
}
