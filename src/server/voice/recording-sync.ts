import "server-only";

import { tenantDb } from "@/server/db/tenant";

/**
 * Whether Vapi accepted an assistant's recording setting. The setting on the assistant's row is
 * only what was asked for. Each attempt to send it leaves rows in the append-only audit log, and
 * the state is worked out from those rows, so a later result can't overwrite an earlier one and
 * a lost row can only make the answer less sure, never more.
 */
export const RECORDING_SYNC_STARTED = "voice_assistant.recording_sync_started";
export const RECORDING_SYNC_APPLIED = "voice_assistant.recording_sync_applied";
export const RECORDING_SYNC_FAILED = "voice_assistant.sync_failed";

const SYNC_ACTIONS = [RECORDING_SYNC_STARTED, RECORDING_SYNC_APPLIED, RECORDING_SYNC_FAILED];

/** Plenty for the overlap below: it takes dozens of saves within a minute to push one out. */
const EVENTS_READ = 40;

/** Past Vapi's 20-second timeout and the server action's own limit. */
const IN_FLIGHT_MS = 60_000;

/** Application servers' clocks can differ, so results this close are treated as overlapping. */
const CLOCK_MARGIN_MS = 2_000;

export type RecordingSyncEvent = { action: string; createdAt: Date; after: unknown };

export type RecordingSyncState = {
  /**
   * "applied": Vapi accepted the setting asked for, which isn't proof of what happens on a call.
   * "failed": the latest attempt failed, so Vapi may hold an earlier setting.
   * "uncertain": nothing can say which setting Vapi holds.
   * "pending": the latest attempt may still be running.
   */
  status: "applied" | "failed" | "uncertain" | "pending";
  lastAccepted: { enabled: boolean; at: Date } | null;
};

type Attempt = {
  enabled: boolean;
  startedAt: Date;
  finished?: { outcome: "applied" | "failed"; at: Date };
};

function readAttempts(events: RecordingSyncEvent[]): Attempt[] {
  const attempts = new Map<string, Attempt>();
  const details = events.flatMap((event) => {
    const { attempt, recordingEnabled } = (event.after ?? {}) as Record<string, unknown>;
    return typeof attempt === "string" ? [{ ...event, attempt, recordingEnabled }] : [];
  });
  for (const event of details) {
    if (event.action === RECORDING_SYNC_STARTED && typeof event.recordingEnabled === "boolean") {
      attempts.set(event.attempt, { enabled: event.recordingEnabled, startedAt: event.createdAt });
    }
  }
  for (const event of details) {
    const attempt = attempts.get(event.attempt);
    if (!attempt) continue;
    if (event.action === RECORDING_SYNC_APPLIED) {
      attempt.finished = { outcome: "applied", at: event.createdAt };
    } else if (event.action === RECORDING_SYNC_FAILED) {
      attempt.finished = { outcome: "failed", at: event.createdAt };
    }
  }
  return [...attempts.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/**
 * Vapi applies PATCHes in an order Syveka can't see. An attempt with a different value could have
 * reached Vapi after the latest one if it finished after the latest began, or if it never reported
 * and could still have been running. So its value could be the one Vapi holds. Attempts with the
 * same value can't disagree about recording.
 */
function couldHaveOverwritten(other: Attempt, latest: Attempt): boolean {
  if (other === latest || other.enabled === latest.enabled) return false;
  const latestBegan = latest.startedAt.getTime();
  return other.finished
    ? other.finished.at.getTime() >= latestBegan - CLOCK_MARGIN_MS
    : other.startedAt.getTime() >= latestBegan - IN_FLIGHT_MS;
}

export function deriveRecordingSyncState(
  events: RecordingSyncEvent[],
  requested: boolean,
  now: Date = new Date(),
): RecordingSyncState {
  const attempts = readAttempts(events);
  const accepted = attempts
    .flatMap((attempt) =>
      attempt.finished?.outcome === "applied"
        ? [{ enabled: attempt.enabled, at: attempt.finished.at }]
        : [],
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const lastAccepted = accepted[0] ?? null;

  const latest = attempts[0];
  // No attempt, or the setting changed with no attempt to send it, such as a crash after saving.
  if (!latest || latest.enabled !== requested) return { status: "uncertain", lastAccepted };
  if (attempts.some((other) => couldHaveOverwritten(other, latest))) {
    return { status: "uncertain", lastAccepted };
  }
  if (latest.finished) return { status: latest.finished.outcome, lastAccepted };
  return {
    status: now.getTime() - latest.startedAt.getTime() < IN_FLIGHT_MS ? "pending" : "uncertain",
    lastAccepted,
  };
}

/** The state of one assistant in one organization, which this read is limited to. */
export async function readRecordingSyncState(
  orgId: string,
  assistantId: string,
  requested: boolean,
): Promise<RecordingSyncState> {
  const events = await tenantDb(orgId).auditLog.findMany({
    where: {
      organizationId: orgId,
      resourceType: "voice_assistant",
      resourceId: assistantId,
      action: { in: SYNC_ACTIONS },
    },
    orderBy: { createdAt: "desc" },
    take: EVENTS_READ,
    select: { action: true, createdAt: true, after: true },
  });
  return deriveRecordingSyncState(events, requested);
}

export type RecordingStatusKind =
  "notConnected" | "needsReview" | "unreadable" | "mismatch" | RecordingSyncState["status"];

/**
 * What the settings page says about recording. A value Vapi itself reports beats the record of
 * what was sent, except while a send is running. Only a stated value that differs counts: Vapi's
 * read leaving the field out says nothing.
 */
export function recordingStatusKind(input: {
  requested: boolean | null;
  inVapi: boolean;
  sync: RecordingSyncState | null;
  reportedByVapi: boolean | null;
}): RecordingStatusKind {
  if (!input.inVapi) return "notConnected";
  if (input.requested === null) return "needsReview";
  if (!input.sync) return "unreadable";
  if (
    input.sync.status !== "pending" &&
    input.reportedByVapi !== null &&
    input.reportedByVapi !== input.requested
  ) {
    return "mismatch";
  }
  return input.sync.status;
}
