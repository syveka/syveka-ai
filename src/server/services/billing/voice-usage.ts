import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { billableMinutes } from "@/server/voice/call-outcome";
import { getMonthUsage } from "./entitlements";

/** A call's longest possible length (maxDurationSeconds in services/voice.ts). */
export const MAX_CALL_MINUTES = 15;
/** Past the longest possible call plus a margin, a call that hasn't ended is lost news. */
export const STALE_CALL_MS = 20 * 60 * 1000;
/**
 * How long an unresolved call counts against limits. Reconciliation can settle nearly every call
 * well within this, and one it can't, such as a call Vapi no longer has, must not keep refusing a
 * customer's calls for the rest of the month over minutes nobody can prove.
 */
export const UNCERTAIN_COUNTS_FOR_MS = 48 * 60 * 60 * 1000;

export type VoiceUsageState = {
  /** Recorded usage: the only figure that may ever reach a customer's bill. */
  billableMinutes: number;
  /** Calls not settled yet, whose final minutes aren't known. Never billed as they stand. */
  uncertainCalls: number;
  /** A cautious estimate of those calls, used only to enforce limits. */
  uncertainMinutes: number;
  /** Unresolved past UNCERTAIN_COUNTS_FOR_MS: no longer counted against limits, and never billed. */
  expiredUncertainCalls: number;
  /** Calls still running, by elapsed time. Also never billed as they stand. */
  inFlightCalls: number;
  inFlightMinutes: number;
};

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Billable usage and uncertain usage, kept apart. Uncertain calls count against limits, so
 * a lost report can't be used to run past a cap, but not as a charge: a failed report must
 * not bill a customer for minutes nobody can prove.
 *
 * A call in progress counts for its elapsed time. A call with no news counts as its longest
 * possible length, since it can't be known to be shorter, until UNCERTAIN_COUNTS_FOR_MS passes.
 * `excludeVapiCallId` leaves out a call that is asking about itself.
 */
export async function getVoiceUsageState(
  orgId: string,
  options: { now?: Date; excludeVapiCallId?: string } = {},
): Promise<VoiceUsageState> {
  const now = options.now ?? new Date();
  const [recorded, unsettled] = await Promise.all([
    getMonthUsage(orgId, "VOICE_MINUTES"),
    unscopedPrisma.voiceCall.findMany({
      where: {
        organizationId: orgId,
        startedAt: { gte: monthStartUtc(now) },
        postCallProcessedAt: null,
        ...(options.excludeVapiCallId ? { vapiCallId: { not: options.excludeVapiCallId } } : {}),
      },
      select: { id: true, startedAt: true, endedAt: true, durationSeconds: true },
    }),
  ]);
  const recordedCallIds = await callsWithRecordedUsage(orgId, unsettled, monthStartUtc(now));

  let uncertainCalls = 0;
  let uncertainMinutes = 0;
  let expiredUncertainCalls = 0;
  let inFlightCalls = 0;
  let inFlightMinutes = 0;
  for (const call of unsettled) {
    const elapsedMs = now.getTime() - call.startedAt.getTime();
    if (call.durationSeconds === null && call.endedAt === null && elapsedMs < STALE_CALL_MS) {
      inFlightCalls++;
      inFlightMinutes += Math.min(MAX_CALL_MINUTES, Math.max(1, Math.ceil(elapsedMs / 60_000)));
      continue;
    }
    // Post-call records usage first and marks the call last, so a failure in between leaves a
    // call whose minutes are already in `recorded`.
    if (recordedCallIds.has(call.id)) continue;
    // Known minutes keep counting: only a length nobody can establish stops counting.
    if (call.durationSeconds === null && elapsedMs >= UNCERTAIN_COUNTS_FOR_MS) {
      expiredUncertainCalls++;
      continue;
    }
    uncertainCalls++;
    uncertainMinutes +=
      call.durationSeconds !== null ? billableMinutes(call.durationSeconds) : MAX_CALL_MINUTES;
  }

  return {
    billableMinutes: recorded,
    uncertainCalls,
    uncertainMinutes,
    expiredUncertainCalls,
    inFlightCalls,
    inFlightMinutes,
  };
}

async function callsWithRecordedUsage(
  orgId: string,
  calls: { id: string; durationSeconds: number | null }[],
  monthStart: Date,
): Promise<Set<string>> {
  const candidates = calls.filter((call) => call.durationSeconds !== null);
  if (candidates.length === 0) return new Set();
  const records = await unscopedPrisma.usageRecord.findMany({
    where: {
      organizationId: orgId,
      metric: "VOICE_MINUTES",
      periodStart: { gte: monthStart },
      OR: candidates.map((call) => ({ metadata: { path: ["callId"], equals: call.id } })),
    },
    select: { metadata: true },
  });
  return new Set(
    records.map((record) => (record.metadata as { callId?: string } | null)?.callId ?? ""),
  );
}

/** What limits compare against. Billable and uncertain stay separate everywhere else. */
export function minutesCountedForLimits(state: VoiceUsageState): number {
  return state.billableMinutes + state.uncertainMinutes + state.inFlightMinutes;
}

/** Minutes left under a limit: never negative, however far usage has run past it. */
export function remainingVoiceMinutes(state: VoiceUsageState, limit: number): number {
  return Math.max(0, limit - minutesCountedForLimits(state));
}
