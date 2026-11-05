import "server-only";

import { spokenDisclosure } from "@/server/ai/prompts/voice";
import { redis } from "@/server/integrations/redis";
import { getVapiAssistant, getVapiCall, VapiHttpError } from "@/server/integrations/vapi";

/**
 * The spoken AI notice is a launch blocker, so it is enforced at each call rather than
 * trusted from configuration: a dashboard edit, or an assistant not re-synced since the
 * notice changed, would otherwise go unnoticed. What the notice says, and whether calls are
 * recorded, are legal decisions that this code doesn't make.
 */
export type DisclosureCheck =
  "ok" | "language_not_approved" | "live_config_mismatch" | "unverifiable";

/** Outlives a call and any late report, including reconciliation's 24-hour look back. */
const VERIFIED_TTL_SECONDS = 48 * 60 * 60;
const VERIFY_TIMEOUT_MS = 3_000;

const verifiedKey = (orgId: string, vapiCallId: string) =>
  `voice:disclosure-ok:${orgId}:${vapiCallId}`;

/**
 * Languages whose wording counsel and a native speaker have approved. Empty by default, so
 * no call can proceed in any language until someone decides, deliberately, per environment.
 */
export function disclosureApprovedLanguages(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    (env.VOICE_DISCLOSURE_APPROVED_LANGUAGES ?? "")
      .split(",")
      .map((language) => language.trim())
      .filter(Boolean),
  );
}

export type LiveAssistantConfig = {
  firstMessage?: string | null;
  firstMessageMode?: string | null;
  firstMessageInterruptionsEnabled?: boolean | null;
};

/** The notice comes first, in the right language, spoken by Vapi in full. */
export function liveConfigDisclosesFirst(language: string, live: LiveAssistantConfig): boolean {
  const notice = spokenDisclosure(language);
  if (notice === null || typeof live.firstMessage !== "string") return false;
  return (
    live.firstMessage.startsWith(notice) &&
    (live.firstMessageMode ?? "assistant-speaks-first") === "assistant-speaks-first" &&
    live.firstMessageInterruptionsEnabled !== true
  );
}

/**
 * Checks a call as it connects against the config at that moment. Only for that moment: a
 * config read later says nothing about what an earlier call's caller heard, so a call whose
 * start was missed is judged by its own record instead (confirmNoticeFromMessages).
 * Anything unconfirmed fails closed.
 */
export async function verifyCallDisclosure(params: {
  orgId: string;
  vapiCallId: string;
  language: string;
  vapiAssistantId: string;
  /** The assistant as sent in the signed webhook, used only when it answers fully. */
  reported?: LiveAssistantConfig | null;
  /** This call's own overrides, which a fetch of the assistant wouldn't show. */
  overrides?: Record<string, unknown> | null;
}): Promise<DisclosureCheck> {
  if (!disclosureApprovedLanguages().has(params.language)) return "language_not_approved";

  if (
    params.overrides &&
    ["firstMessage", "firstMessageMode", "firstMessageInterruptionsEnabled"].some(
      (field) => field in (params.overrides as object),
    )
  ) {
    return "live_config_mismatch";
  }

  let live: LiveAssistantConfig | null = null;
  const reported = params.reported;
  if (
    typeof reported?.firstMessage === "string" &&
    typeof reported.firstMessageMode === "string" &&
    typeof reported.firstMessageInterruptionsEnabled === "boolean"
  ) {
    live = reported;
  } else {
    try {
      live = await getVapiAssistant(params.vapiAssistantId, AbortSignal.timeout(VERIFY_TIMEOUT_MS));
    } catch {
      return "unverifiable";
    }
  }
  if (!liveConfigDisclosesFirst(params.language, live)) return "live_config_mismatch";

  try {
    await redis.set(verifiedKey(params.orgId, params.vapiCallId), "1", {
      ex: VERIFIED_TTL_SECONDS,
    });
  } catch {
    return "unverifiable";
  }
  return "ok";
}

/** Compares speech loosely: a provider's transcript may differ in spacing and punctuation. */
function normalizeSpeech(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{M}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpokenEvidence = "spoken" | "contradicted" | "absent";

/**
 * What a call's own record says it opened with. Vapi documents artifact.messages as "the
 * messages that were spoken during the call", so unlike its current configuration this
 * belongs to this call. "contradicted" means the assistant spoke, and something else came
 * first. "absent" means the record can't say, which isn't a refusal.
 */
export function noticeEvidenceInMessages(
  language: string,
  messages: unknown,
  vapiAssistantId: string,
): SpokenEvidence {
  const notice = spokenDisclosure(language);
  if (notice === null || !Array.isArray(messages)) return "absent";
  const spoken = messages.flatMap((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { role, message, secondsFromStart, assistantId } = entry as Record<string, unknown>;
    if (role !== "bot" || typeof message !== "string" || !message.trim()) return [];
    // A message credited to another assistant isn't this assistant's evidence.
    if (typeof assistantId === "string" && assistantId !== vapiAssistantId) return [];
    return [{ message, at: typeof secondsFromStart === "number" ? secondsFromStart : index }];
  });
  if (spoken.length === 0) return "absent";
  const first = spoken.reduce((earliest, next) => (next.at < earliest.at ? next : earliest));
  return normalizeSpeech(first.message).startsWith(normalizeSpeech(notice))
    ? "spoken"
    : "contradicted";
}

export type NoticeConfirmation = "ok" | "refused" | "absent" | "unverifiable";

/**
 * Judges a call whose start wasn't checked, from messages belonging to that call. "ok" is
 * stored so later steps agree. "refused" is final, for the caller to record. An unapproved
 * language is refused because it couldn't have been allowed to run at all.
 */
export async function confirmNoticeFromMessages(params: {
  orgId: string;
  vapiCallId: string;
  language: string;
  vapiAssistantId: string;
  messages: unknown;
}): Promise<NoticeConfirmation> {
  if (!disclosureApprovedLanguages().has(params.language)) return "refused";
  const evidence = noticeEvidenceInMessages(
    params.language,
    params.messages,
    params.vapiAssistantId,
  );
  if (evidence === "contradicted") return "refused";
  if (evidence === "absent") return "absent";
  try {
    await redis.set(verifiedKey(params.orgId, params.vapiCallId), "1", {
      ex: VERIFIED_TTL_SECONDS,
    });
    return "ok";
  } catch {
    return "unverifiable";
  }
}

/**
 * The messages on Vapi's record of this call, if that record is about this call and this
 * assistant. Another call's or another assistant's record is treated as no record at all.
 */
async function callRecordMessages(
  vapiCallId: string,
  vapiAssistantId: string,
): Promise<{ messages: unknown } | "none" | "unavailable"> {
  let record: unknown;
  try {
    record = await getVapiCall(vapiCallId, AbortSignal.timeout(VERIFY_TIMEOUT_MS));
  } catch (error) {
    return error instanceof VapiHttpError && error.status === 404 ? "none" : "unavailable";
  }
  if (typeof record !== "object" || record === null) return "none";
  const { id, assistantId, artifact } = record as {
    id?: unknown;
    assistantId?: unknown;
    artifact?: { messages?: unknown } | null;
  };
  if (id !== vapiCallId || assistantId !== vapiAssistantId) return "none";
  return { messages: artifact?.messages };
}

/**
 * As confirmNoticeFromMessages, falling back to Vapi's record of the call when the messages
 * at hand can't say. "unverifiable" means ask again, because the record couldn't be read.
 */
export async function confirmNoticeFromCallRecord(params: {
  orgId: string;
  vapiCallId: string;
  language: string;
  vapiAssistantId: string;
  messages: unknown;
}): Promise<NoticeConfirmation> {
  const fromMessages = await confirmNoticeFromMessages(params);
  if (fromMessages !== "absent") return fromMessages;
  const record = await callRecordMessages(params.vapiCallId, params.vapiAssistantId);
  if (record === "unavailable") return "unverifiable";
  if (record === "none") return "absent";
  return confirmNoticeFromMessages({ ...params, messages: record.messages });
}

/** Whether this call passed the check, or "unknown" when that can't be read. */
export async function callDisclosureState(
  orgId: string,
  vapiCallId: string,
): Promise<"verified" | "unverified" | "unknown"> {
  try {
    return (await redis.get(verifiedKey(orgId, vapiCallId))) ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}
