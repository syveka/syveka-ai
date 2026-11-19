import type { Prisma } from "@/generated/prisma/client/client";

/** No assistant is configured beyond this, so anything longer is bad data, not a long call. */
const MAX_PLAUSIBLE_CALL_SECONDS = 4 * 60 * 60;

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export type CallTimes = {
  startedAt?: string | null;
  endedAt?: string | null;
  /** Not in Vapi's published report schema: used only when the times are absent. */
  durationSeconds?: number | null;
};

/**
 * A call's length in whole seconds, or null when nothing trustworthy says.
 *
 * Null must never become a charge or be mistaken for a free call: the call stays
 * unsettled for reconciliation. Vapi's published end-of-call-report documents
 * startedAt and endedAt, not durationSeconds, so the times come first.
 */
export function resolveCallDurationSeconds(times: CallTimes): number | null {
  const started = parseTime(times.startedAt);
  const ended = parseTime(times.endedAt);
  if (started !== null && ended !== null) {
    const seconds = Math.ceil((ended - started) / 1000);
    return seconds >= 0 && seconds <= MAX_PLAUSIBLE_CALL_SECONDS ? seconds : null;
  }
  const reported = times.durationSeconds;
  if (typeof reported !== "number" || !Number.isFinite(reported)) return null;
  if (reported < 0 || reported > MAX_PLAUSIBLE_CALL_SECONDS) return null;
  return Math.ceil(reported);
}

/** Minutes a call counts for: rounded up, and nothing for a call that never connected. */
export function billableMinutes(durationSeconds: number): number {
  return durationSeconds > 0 ? Math.ceil(durationSeconds / 60) : 0;
}

export type CallOutcomeInput = {
  endedReason?: string | null;
  cost?: number | null;
  durationSeconds: number | null;
  endedAt: Date;
  messages?: unknown[] | null;
  recordingUrl?: string | null;
};

/** The fields a finished call writes to its row, however the news of it arrived. */
export function callOutcomeFields(input: CallOutcomeInput) {
  return {
    status: input.endedReason === "assistant-forwarded-call" ? "TRANSFERRED" : "COMPLETED",
    endedAt: input.endedAt,
    durationSeconds: input.durationSeconds,
    costCents: Math.round((input.cost ?? 0) * 100),
    endedReason: input.endedReason ?? undefined,
    transcript: (input.messages ?? undefined) as Prisma.InputJsonValue | undefined,
    recordingUrl: input.recordingUrl ?? undefined,
  } as const;
}
