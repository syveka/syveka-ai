import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { getBusinessDnaContext } from "@/server/business-dna/context";
import { getEmailChannelAdapter } from "@/server/channels/email";
import type { TenantContext } from "@/server/auth/session";

export type ReadinessState = "ready" | "setup_required" | "not_configured" | "blocked";

export type ReadinessItemKey = "businessDna" | "emailChannel" | "booking" | "crm";

export type ReadinessItem = {
  key: ReadinessItemKey;
  state: ReadinessState;
};

function businessDnaHasAnyFact(dna: Awaited<ReturnType<typeof getBusinessDnaContext>>): boolean {
  if (!dna) return false;
  return Boolean(
    dna.displayName ||
    dna.industry ||
    dna.productsServices ||
    dna.policies ||
    dna.pricingNotes ||
    dna.targetCustomer ||
    dna.keyFacts.length > 0,
  );
}

/**
 * Truthful, org-scoped setup-readiness summary for the core MVP loop
 * (Business DNA -> Email channel -> Booking -> CRM). Deliberately excludes
 * optional parallel channels (Voice, Calendar, Stripe billing) — they are
 * not part of the Dashboard -> Inbox -> ... workflow this checklist targets,
 * and marking an intentionally-unused optional channel "not configured"
 * would be a misleading, not truthful, signal. Never fabricates a "blocked"
 * state: nothing here currently detects a broken-but-previously-working
 * integration (unlike Calendar's NEEDS_REAUTH), so that state is reserved
 * in the type but not emitted today.
 */
export async function getOrgSetupReadiness(ctx: TenantContext): Promise<ReadinessItem[]> {
  const db = tenantDb(ctx.orgId);

  const [businessDna, activeBookingTypeCount] = await Promise.all([
    getBusinessDnaContext(ctx.orgId),
    db.bookingType.count({ where: { isActive: true, deletedAt: null } }),
  ]);

  const emailAdapter = getEmailChannelAdapter();
  const emailState: ReadinessState =
    emailAdapter.provider === "RESEND" && emailAdapter.isConfigured() ? "ready" : "not_configured";

  return [
    {
      key: "businessDna",
      state: businessDnaHasAnyFact(businessDna) ? "ready" : "setup_required",
    },
    { key: "emailChannel", state: emailState },
    { key: "booking", state: activeBookingTypeCount > 0 ? "ready" : "setup_required" },
    // CRM has no external configuration or org action required to become
    // usable — it is ready as soon as the organization exists.
    { key: "crm", state: "ready" },
  ];
}
