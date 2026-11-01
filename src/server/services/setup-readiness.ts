import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { getBusinessDnaContext } from "@/server/business-dna/context";
import { getEmailChannelAdapter } from "@/server/channels/email";
import { getEntitlements } from "@/server/services/billing/entitlements";
import type { TenantContext } from "@/server/auth/session";

export type ReadinessState =
  | "ready"
  | "setup_required"
  | "not_configured"
  | "blocked"
  | "verification_required"
  | "plan_required";

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
    dna.otherPolicies ||
    dna.cancellationPolicy ||
    dna.bookingPolicy ||
    dna.refundPolicy ||
    dna.paymentPolicy ||
    dna.pricingNotes ||
    dna.targetCustomer ||
    dna.keyFacts.length > 0 ||
    dna.services.length > 0,
  );
}

/**
 * The email channel's truthful state, shared by the Dashboard readiness
 * checklist and the Inbox status line so both say the same thing:
 *
 * - `mock`: the test provider is active; messages are simulated.
 * - `not_configured`: Resend credentials are missing.
 * - `no_address`: credentials are present, but this organization has no
 *   receiving address (InboxMailbox row), so inbound email can't be routed to
 *   it: the inbound webhooks only accept mail addressed to a known mailbox.
 * - `verification_required`: credentials and a receiving address are
 *   present, but no real inbound email has been received yet, so nothing
 *   proves mail actually reaches the inbox (configuration alone is not
 *   end-to-end capability).
 * - `ready`: a real inbound email (with a provider message id) has been
 *   received. This proves receiving only; it says nothing about sending.
 */
export type EmailChannelStatus =
  "mock" | "not_configured" | "no_address" | "verification_required" | "ready";

export async function getEmailChannelStatus(ctx: TenantContext): Promise<EmailChannelStatus> {
  const adapter = getEmailChannelAdapter();
  if (adapter.provider === "MOCK") return "mock";
  if (adapter.provider !== "RESEND" || !adapter.isConfigured()) return "not_configured";
  const hasReceivedRealEmail = await tenantDb(ctx.orgId).inboxThread.findFirst({
    where: {
      channel: "EMAIL",
      messages: { some: { direction: "INBOUND", externalId: { not: null } } },
    },
    select: { id: true },
  });
  if (hasReceivedRealEmail) return "ready";
  return (await getEmailReceivingAddress(ctx)) ? "verification_required" : "no_address";
}

/** The organization's own inbound address, if one has been set up. */
export async function getEmailReceivingAddress(ctx: TenantContext): Promise<string | null> {
  const mailbox = await tenantDb(ctx.orgId).inboxMailbox.findFirst({
    where: { channel: "EMAIL" },
    select: { address: true },
  });
  return mailbox?.address ?? null;
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
    emailStatus,
    activeVoiceAssistant,
    hasCompletedRealCall,
    entitlements,
  ] = await Promise.all([
    getBusinessDnaContext(ctx.orgId),
    db.bookingType.count({ where: { isActive: true, deletedAt: null } }),
    getEmailChannelStatus(ctx),
    db.voiceAssistant.findFirst({
      where: { isActive: true, vapiAssistantId: { not: null } },
      select: { id: true },
    }),
    db.voiceCall.findFirst({ where: { status: "COMPLETED" }, select: { id: true } }),
    getEntitlements(ctx.orgId),
  ]);

  // The simulated test provider is not a configured channel; an org without
  // a receiving address has setup left to do before any email can arrive.
  const emailState: ReadinessState =
    emailStatus === "mock"
      ? "not_configured"
      : emailStatus === "no_address"
        ? "setup_required"
        : emailStatus;

  // A plan without voice assistants can't set one up: say so rather than
  // pointing at a setup page that will refuse.
  const voiceState: ReadinessState = !activeVoiceAssistant
    ? entitlements.voiceAssistants > 0
      ? "setup_required"
      : "plan_required"
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
