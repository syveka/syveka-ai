import "server-only";

import { getVapiEnv } from "@/env";
import { spokenDisclosure } from "@/server/ai/prompts/voice";
import { getVapiAssistant } from "@/server/integrations/vapi";
import { getVoiceUsageState, remainingVoiceMinutes } from "@/server/services/billing/voice-usage";
import { disclosureApprovedLanguages, liveConfigDisclosesFirst } from "./disclosure-gate";

export type ReadinessBlocker =
  | "voiceNotSetUp"
  | "noticeAwaitingApproval"
  | "notSynced"
  | "syncOutdated"
  | "syncUnverifiable"
  | "noPhoneNumber"
  | "inactive"
  | "noMinutes"
  | "minutesUsed"
  | "readOnly";

export type AssistantReadiness = {
  blockers: ReadinessBlocker[];
  /** What callers hear first, for the assistant's language. */
  notice: string | null;
  noticeApproved: boolean;
};

const LIVE_CHECK_TIMEOUT_MS = 3_000;

function vapiConfigured(): boolean {
  try {
    getVapiEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * What the server can tell about whether an assistant can take calls, in the same terms the
 * webhook enforces. Reads only, and returns codes, never provider errors or configuration
 * values. It can't show that a real call works, only what would stop one.
 */
export async function getAssistantReadiness(
  orgId: string,
  assistant: {
    language: string;
    vapiAssistantId: string | null;
    phoneNumber: string | null;
    isActive: boolean;
  },
  ent: { voiceMinutesMonth: number; readOnly: boolean },
): Promise<AssistantReadiness> {
  const blockers: ReadinessBlocker[] = [];
  const noticeApproved = disclosureApprovedLanguages().has(assistant.language);
  const configured = vapiConfigured();

  if (!configured) blockers.push("voiceNotSetUp");
  if (!noticeApproved) blockers.push("noticeAwaitingApproval");

  if (!assistant.vapiAssistantId) {
    if (configured) blockers.push("notSynced");
  } else if (configured) {
    try {
      const live = await getVapiAssistant(
        assistant.vapiAssistantId,
        AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS),
      );
      if (!liveConfigDisclosesFirst(assistant.language, live)) blockers.push("syncOutdated");
    } catch {
      blockers.push("syncUnverifiable");
    }
  }

  if (!assistant.phoneNumber) blockers.push("noPhoneNumber");
  else if (!assistant.isActive) blockers.push("inactive");

  if (ent.readOnly) blockers.push("readOnly");
  if (ent.voiceMinutesMonth <= 0) {
    blockers.push("noMinutes");
  } else {
    // Unreadable usage isn't a finding: the webhook still checks it at each call.
    const usage = await getVoiceUsageState(orgId).catch(() => null);
    if (usage && remainingVoiceMinutes(usage, ent.voiceMinutesMonth) === 0) {
      blockers.push("minutesUsed");
    }
  }

  return { blockers, notice: spokenDisclosure(assistant.language), noticeApproved };
}
