import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { getBusinessDnaContext } from "@/server/business-dna/context";
import { getEmailChannelAdapter } from "@/server/channels/email";
import type { TenantContext } from "@/server/auth/session";

export type ReadinessState =
  "ready" | "setup_required" | "not_configured" | "blocked" | "verification_required";

export type ReadinessItemKey = "businessDna" | "emailChannel" | "booking" | "crm" | "voice";

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
 * (Business DNA -> Email channel -> Booking -> CRM -> Voice). Deliberately
 * excludes Calendar and Stripe billing — outside the Dashboard -> Inbox ->
 * ... workflow this checklist targets, and marking an intentionally-unused
 * optional channel "not configured" would be a misleading, not truthful,
 * signal.
 *
 * `emailChannel` and `voice` use `verification_required` rather than
 * `ready` when credentials are present but there is no LOCAL evidence the
 * integration has actually round-tripped with the real external provider
 * (an inbound email actually received; a voice call actually completed) —
 * this app has no way to run a live check against Resend/Vapi from here,
 * so claiming "ready" from config presence alone would overclaim. `ready`
 * is only reported once real inbound activity proves it. `blocked` is
 * reserved in the type but never emitted — nothing here detects a
 * previously-working-now-broken integration (unlike Calendar's
 * NEEDS_REAUTH), so fabricating that state would violate "truthful states
 * only."
 */
export async function getOrgSetupReadiness(ctx: TenantContext): Promise<ReadinessItem[]> {
  const db = tenantDb(ctx.orgId);

  const [
    businessDna,
    activeBookingTypeCount,
    hasReceivedRealEmail,
    activeVoiceAssistant,
    hasCompletedRealCall,
  ] = await Promise.all([
    getBusinessDnaContext(ctx.orgId),
    db.bookingType.count({ where: { isActive: true, deletedAt: null } }),
    db.inboxThread.findFirst({
      where: {
        channel: "EMAIL",
        messages: { some: { direction: "INBOUND", externalId: { not: null } } },
      },
      select: { id: true },
    }),
    db.voiceAssistant.findFirst({
      where: { isActive: true, vapiAssistantId: { not: null } },
      select: { id: true },
    }),
    db.voiceCall.findFirst({ where: { status: "COMPLETED" }, select: { id: true } }),
  ]);

  const emailAdapter = getEmailChannelAdapter();
  const emailConfigured = emailAdapter.provider === "RESEND" && emailAdapter.isConfigured();
  const emailState: ReadinessState = !emailConfigured
    ? "not_configured"
    : hasReceivedRealEmail
      ? "ready"
      : "verification_required";

  const voiceState: ReadinessState = !activeVoiceAssistant
    ? "setup_required"
    : hasCompletedRealCall
      ? "ready"
      : "verification_required";

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
    { key: "voice", state: voiceState },
  ];
}
