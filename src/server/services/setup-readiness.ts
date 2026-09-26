import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { getBusinessDnaContext } from "@/server/business-dna/context";
import { getEmailChannelAdapter, isInboundEmailConfigured } from "@/server/channels/email";
import { getVapiEnv } from "@/env";
import type { TenantContext } from "@/server/auth/session";

export type ReadinessState =
  "ready" | "setup_required" | "not_configured" | "blocked" | "verification_required";

export type ReadinessItemKey = "businessDna" | "emailChannel" | "booking" | "crm" | "voice";

/**
 * The specific missing step behind a non-ready state, so the checklist can
 * tell an operator exactly what to do next instead of a bare badge.
 */
export type ReadinessHint =
  | "email_outbound_not_configured"
  | "email_inbound_not_configured"
  | "email_mailbox_not_provisioned"
  | "email_awaiting_first_inbound"
  | "email_awaiting_first_reply"
  | "voice_provider_not_configured"
  | "voice_no_assistant"
  | "voice_assistant_not_synced"
  | "voice_phone_number_missing"
  | "voice_awaiting_first_call";

export type ReadinessItem = {
  key: ReadinessItemKey;
  state: ReadinessState;
  hint?: ReadinessHint;
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

/** Presence-only check of the Vapi integration's own scoped config. */
function isVapiConfigured(): boolean {
  try {
    const env = getVapiEnv();
    return Boolean(env.VAPI_API_KEY && env.VAPI_WEBHOOK_SECRET && env.VAPI_WEBHOOK_CREDENTIAL_ID);
  } catch {
    return false;
  }
}

type EmailEvidence = {
  hasMailbox: boolean;
  hasReceivedRealEmail: boolean;
  hasSentRealEmail: boolean;
};

/** Prefix the mock adapter gives its fake provider ids (`channels/email/mock.ts`). */
const MOCK_EMAIL_ID_PREFIX = "mock-email-";

function emailReadiness({
  hasMailbox,
  hasReceivedRealEmail,
  hasSentRealEmail,
}: EmailEvidence): ReadinessItem {
  const adapter = getEmailChannelAdapter();
  if (adapter.provider !== "RESEND" || !adapter.isConfigured()) {
    return { key: "emailChannel", state: "not_configured", hint: "email_outbound_not_configured" };
  }
  if (!isInboundEmailConfigured()) {
    return { key: "emailChannel", state: "setup_required", hint: "email_inbound_not_configured" };
  }
  if (!hasMailbox) {
    return { key: "emailChannel", state: "setup_required", hint: "email_mailbox_not_provisioned" };
  }
  if (!hasReceivedRealEmail) {
    return {
      key: "emailChannel",
      state: "verification_required",
      hint: "email_awaiting_first_inbound",
    };
  }
  // Receiving alone doesn't prove the channel works: Resend rejects sends
  // from a domain that isn't verified for sending.
  if (!hasSentRealEmail) {
    return {
      key: "emailChannel",
      state: "verification_required",
      hint: "email_awaiting_first_reply",
    };
  }
  return { key: "emailChannel", state: "ready" };
}

type VoiceAssistantSummary = {
  isActive: boolean;
  vapiAssistantId: string | null;
};

function voiceReadiness(
  assistants: VoiceAssistantSummary[],
  hasCompletedRealCall: boolean,
): ReadinessItem {
  if (!isVapiConfigured()) {
    return { key: "voice", state: "not_configured", hint: "voice_provider_not_configured" };
  }
  if (assistants.length === 0) {
    return { key: "voice", state: "setup_required", hint: "voice_no_assistant" };
  }
  const synced = assistants.filter((a) => a.vapiAssistantId !== null);
  if (synced.length === 0) {
    return { key: "voice", state: "setup_required", hint: "voice_assistant_not_synced" };
  }
  // `activateAssistant` only sets isActive once a phone number is attached,
  // so a synced-but-inactive assistant is specifically missing its number.
  if (!synced.some((a) => a.isActive)) {
    return { key: "voice", state: "setup_required", hint: "voice_phone_number_missing" };
  }
  if (!hasCompletedRealCall) {
    return { key: "voice", state: "verification_required", hint: "voice_awaiting_first_call" };
  }
  return { key: "voice", state: "ready" };
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
 * `ready` when every configuration step is complete but there is no LOCAL
 * evidence the integration has actually round-tripped with the real
 * external provider (an inbound email actually received AND a reply
 * actually accepted by Resend; a voice call actually completed on a
 * currently-live assistant) — this app has no way to run a live check against
 * Resend/Vapi from here, so claiming "ready" from config presence alone
 * would overclaim. Missing configuration steps (inbound email not wired, no
 * org mailbox, no synced assistant, no phone number) report
 * `setup_required` with a `hint` naming the exact step, rather than
 * asking the operator to "verify" something that cannot work yet.
 * `blocked` is reserved in the type but never emitted — nothing here
 * detects a previously-working-now-broken integration (unlike Calendar's
 * NEEDS_REAUTH), so fabricating that state would violate "truthful states
 * only."
 */
export async function getOrgSetupReadiness(ctx: TenantContext): Promise<ReadinessItem[]> {
  const db = tenantDb(ctx.orgId);

  const [
    businessDna,
    activeBookingTypeCount,
    emailMailbox,
    hasReceivedRealEmail,
    hasSentRealEmail,
    voiceAssistants,
    hasCompletedRealCall,
  ] = await Promise.all([
    getBusinessDnaContext(ctx.orgId),
    db.bookingType.count({ where: { isActive: true, deletedAt: null } }),
    db.inboxMailbox.findFirst({ where: { channel: "EMAIL" }, select: { id: true } }),
    db.inboxThread.findFirst({
      where: {
        channel: "EMAIL",
        deletedAt: null,
        messages: { some: { direction: "INBOUND", externalId: { not: null } } },
      },
      select: { id: true },
    }),
    // A provider id is only written after the adapter's send succeeded;
    // mock-provider ids are excluded so simulated sends never count.
    db.inboxThread.findFirst({
      where: {
        channel: "EMAIL",
        deletedAt: null,
        messages: {
          some: {
            direction: "OUTBOUND",
            status: "SENT",
            AND: [
              { externalId: { not: null } },
              { NOT: { externalId: { startsWith: MOCK_EMAIL_ID_PREFIX } } },
            ],
          },
        },
      },
      select: { id: true },
    }),
    db.voiceAssistant.findMany({ select: { isActive: true, vapiAssistantId: true } }),
    // Only a call handled by an assistant that is still live counts — a
    // completed call on a since-deactivated assistant (or its old number)
    // proves nothing about the current setup.
    db.voiceCall.findFirst({
      where: {
        status: "COMPLETED",
        assistant: { isActive: true, vapiAssistantId: { not: null } },
      },
      select: { id: true },
    }),
  ]);

  return [
    {
      key: "businessDna",
      state: businessDnaHasAnyFact(businessDna) ? "ready" : "setup_required",
    },
    emailReadiness({
      hasMailbox: Boolean(emailMailbox),
      hasReceivedRealEmail: Boolean(hasReceivedRealEmail),
      hasSentRealEmail: Boolean(hasSentRealEmail),
    }),
    { key: "booking", state: activeBookingTypeCount > 0 ? "ready" : "setup_required" },
    // CRM has no external configuration or org action required to become
    // usable — it is ready as soon as the organization exists.
    { key: "crm", state: "ready" },
    voiceReadiness(voiceAssistants, Boolean(hasCompletedRealCall)),
  ];
}
