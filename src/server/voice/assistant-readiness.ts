import "server-only";

import { getVapiEnv } from "@/env";
import { spokenDisclosure } from "@/server/ai/prompts/voice";
import { getVapiAssistant } from "@/server/integrations/vapi";
import {
  getVoiceUsageState,
  MAX_CALL_MINUTES,
  remainingVoiceMinutes,
} from "@/server/services/billing/voice-usage";
import { disclosureApprovedLanguages, liveConfigDisclosesFirst } from "./disclosure-gate";

export type ReadinessBlocker =
  | "voiceNotSetUp"
  | "noticeAwaitingApproval"
  | "notSynced"
  | "syncOutdated"
  | "syncUnverifiable"
  | "usageUnverifiable"
  | "noPhoneNumber"
  | "inactive"
  | "noMinutes"
  | "minutesUsed"
  | "readOnly";

export type AssistantReadiness = {
  blockers: ReadinessBlocker[];
  /** "unverified": the only problems found are checks that couldn't be completed. */
  status: "clear" | "blocked" | "unverified";
  /** What callers hear first, for the assistant's language. */
  notice: string | null;
  noticeApproved: boolean;
  /** What Vapi itself reports, when it states a value. Null says nothing either way. */
  recordingReportedByVapi: boolean | null;
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
  /** Null when the plan couldn't be read, which isn't a finding. */
  ent: { voiceMinutesMonth: number; readOnly: boolean } | null,
): Promise<AssistantReadiness> {
  const blockers: ReadinessBlocker[] = [];
  const noticeApproved = disclosureApprovedLanguages().has(assistant.language);
  const configured = vapiConfigured();
  let recordingReportedByVapi: boolean | null = null;

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
      const reported = live.artifactPlan?.recordingEnabled;
      if (typeof reported === "boolean") recordingReportedByVapi = reported;
      // A dashboard edit can lengthen calls past what the limits and call slots allow for.
      const runsTooLong =
        typeof live.maxDurationSeconds === "number" &&
        live.maxDurationSeconds > MAX_CALL_MINUTES * 60;
      if (!liveConfigDisclosesFirst(assistant.language, live) || runsTooLong) {
        blockers.push("syncOutdated");
      }
    } catch {
      blockers.push("syncUnverifiable");
    }
  }

  if (!assistant.phoneNumber) blockers.push("noPhoneNumber");
  else if (!assistant.isActive) blockers.push("inactive");

  if (ent?.readOnly) blockers.push("readOnly");
  if (!ent) {
    blockers.push("usageUnverifiable");
  } else if (ent.voiceMinutesMonth <= 0) {
    blockers.push("noMinutes");
  } else {
    const usage = await getVoiceUsageState(orgId).catch(() => null);
    if (!usage) blockers.push("usageUnverifiable");
    else if (remainingVoiceMinutes(usage, ent.voiceMinutesMonth) === 0)
      blockers.push("minutesUsed");
  }

  const status =
    blockers.length === 0
      ? "clear"
      : blockers.every(
            (blocker) => blocker === "syncUnverifiable" || blocker === "usageUnverifiable",
          )
        ? "unverified"
        : "blocked";
  return {
    blockers,
    status,
    notice: spokenDisclosure(assistant.language),
    noticeApproved,
    recordingReportedByVapi,
  };
}
