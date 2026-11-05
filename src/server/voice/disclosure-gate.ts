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
/** Shorter than the 48 hours a refusal is remembered (call-admission.ts). */
const EVIDENCE_WINDOW_MS = 36 * 60 * 60 * 1000;

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
    .replace(/\p{M}+/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpokenEvidence = "spoken" | "contradicted" | "absent";

/**
 * What a call's own record says it opened with. Vapi documents artifact.messages as "the
 * messages that were spoken during the call", so unlike its current configuration this
 * belongs to this call. The opening is the assistant's first run of speech, which Vapi may
 * split across entries. "contradicted" means the assistant spoke, and something else came
 * first. "absent" means the record can't say, which isn't a refusal.
 */
export function noticeEvidenceInMessages(
  language: string,
  messages: unknown,
  vapiAssistantId: string,
): SpokenEvidence {
  const notice = spokenDisclosure(language);
  if (notice === null || !Array.isArray(messages)) return "absent";
  const turns = messages.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { role, message, secondsFromStart, assistantId } = entry as Record<string, unknown>;
    if ((role !== "bot" && role !== "user") || typeof message !== "string" || !message.trim()) {
      return [];
    }
    return [{ role, message, at: secondsFromStart, assistantId }];
  });
  // Order decides this, so a time that can't be trusted leaves the record unable to say.
  if (!turns.every(({ at }) => typeof at === "number" && Number.isFinite(at) && at >= 0)) {
    return "absent";
  }
  const ordered = [...turns].sort((a, b) => (a.at as number) - (b.at as number));
  const firstSpoken = ordered.findIndex(({ role }) => role === "bot");
  if (firstSpoken < 0) return "absent";
  const opening: string[] = [];
  for (const turn of ordered.slice(firstSpoken)) {
    if (turn.role !== "bot") break;
    // Another assistant's words aren't this assistant's evidence, for or against.
    if (typeof turn.assistantId === "string" && turn.assistantId !== vapiAssistantId) break;
    opening.push(turn.message);
  }
  if (opening.length === 0) return "absent";
  const said = normalizeSpeech(opening.join(" "));
  const expected = normalizeSpeech(notice);
  return said === expected || said.startsWith(`${expected} `) ? "spoken" : "contradicted";
}

/**
 * A signed message never expires, and a refusal is remembered for a limited time. So evidence
 * only counts for a call well inside that memory: anything older could be the replay of a
 * call whose refusal has since been forgotten. A call with no readable time doesn't qualify.
 */
function withinRefusalMemory(calledAt: string | null | undefined, now: Date): boolean {
  const ms = calledAt ? Date.parse(calledAt) : Number.NaN;
  return !Number.isNaN(ms) && now.getTime() - ms <= EVIDENCE_WINDOW_MS;
}

/**
 * "not_approved" isn't recorded as a refusal: approval is today's setting, not a fact about
 * this call, and a setting missing during a deploy mustn't lose a good call for good.
 */
export type NoticeConfirmation = "ok" | "contradicted" | "not_approved" | "absent" | "unverifiable";

type ConfirmParams = {
  orgId: string;
  vapiCallId: string;
  language: string;
  vapiAssistantId: string;
  messages: unknown;
  /** When this call began, as stated by the signed message or Vapi's record. */
  calledAt: string | null | undefined;
  now?: Date;
};

/**
 * Judges a call whose start wasn't checked, from messages belonging to that call. "ok" is
 * stored so later steps agree. "contradicted" is final, for the caller to record.
 */
export async function confirmNoticeFromMessages(
  params: ConfirmParams,
): Promise<NoticeConfirmation> {
  if (!disclosureApprovedLanguages().has(params.language)) return "not_approved";
  if (!withinRefusalMemory(params.calledAt, params.now ?? new Date())) return "absent";
  const evidence = noticeEvidenceInMessages(
    params.language,
    params.messages,
    params.vapiAssistantId,
  );
  if (evidence !== "spoken") return evidence;
  try {
    await redis.set(verifiedKey(params.orgId, params.vapiCallId), "1", {
      ex: VERIFIED_TTL_SECONDS,
    });
    return "ok";
  } catch {
    return "unverifiable";
  }
}

type CallRecord = {
  status: unknown;
  endedAt: unknown;
  calledAt: string | undefined;
  messages: unknown;
};

/**
 * Vapi's record of this call, if it is about this call and this assistant. Another call's or
 * another assistant's record is treated as no record at all.
 */
async function readCallRecord(
  vapiCallId: string,
  vapiAssistantId: string,
): Promise<CallRecord | "none" | "unavailable"> {
  let record: unknown;
  try {
    record = await getVapiCall(vapiCallId, AbortSignal.timeout(VERIFY_TIMEOUT_MS));
  } catch (error) {
    return error instanceof VapiHttpError && error.status === 404 ? "none" : "unavailable";
  }
  if (typeof record !== "object" || record === null) return "none";
  const { id, assistantId, status, startedAt, createdAt, endedAt, artifact } = record as {
    id?: unknown;
    assistantId?: unknown;
    status?: unknown;
    startedAt?: unknown;
    createdAt?: unknown;
    endedAt?: unknown;
    artifact?: { messages?: unknown } | null;
  };
  if (id !== vapiCallId || assistantId !== vapiAssistantId) return "none";
  const calledAt = [startedAt, createdAt].find((time) => typeof time === "string") as
    string | undefined;
  return { status, endedAt, calledAt, messages: artifact?.messages };
}

/**
 * Whether a start message is about a call still running. A start arriving late, or replayed,
 * can't be checked against the configuration "at that moment": that moment has passed. Asked
 * of Vapi because a signed body stays the same however old it is. "unknown" means ask again.
 */
export async function callLiveness(
  vapiCallId: string,
  vapiAssistantId: string,
): Promise<"live" | "ended" | "unknown"> {
  const record = await readCallRecord(vapiCallId, vapiAssistantId);
  if (record === "none" || record === "unavailable") return "unknown";
  if (record.status === "ended" || record.endedAt) return "ended";
  return typeof record.status === "string" ? "live" : "unknown";
}

/**
 * As confirmNoticeFromMessages, falling back to Vapi's record of the call when the messages
 * at hand can't say. "unverifiable" means ask again, because the record couldn't be read.
 */
export async function confirmNoticeFromCallRecord(
  params: ConfirmParams,
): Promise<NoticeConfirmation> {
  const fromMessages = await confirmNoticeFromMessages(params);
  if (fromMessages !== "absent") return fromMessages;
  const record = await readCallRecord(params.vapiCallId, params.vapiAssistantId);
  if (record === "unavailable") return "unverifiable";
  if (record === "none") return "absent";
  return confirmNoticeFromMessages({
    ...params,
    messages: record.messages,
    calledAt: record.calledAt,
  });
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
