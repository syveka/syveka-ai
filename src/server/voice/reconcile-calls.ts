import "server-only";

import { z } from "zod";
import { unscopedPrisma } from "@/server/db/tenant";
import {
  getVapiCall,
  listVapiCalls,
  VAPI_CALL_LIST_LIMIT,
  VapiHttpError,
} from "@/server/integrations/vapi";
import { enqueue } from "@/server/jobs/queue";
import { STALE_CALL_MS, UNCERTAIN_COUNTS_FOR_MS } from "@/server/services/billing/voice-usage";
import { callRefusal, markCallRefused } from "@/server/voice/call-admission";
import { callOutcomeFields, resolveCallDurationSeconds } from "@/server/voice/call-outcome";
import {
  callDisclosureState,
  confirmNoticeFromCallRecord,
  earliestCallTime,
} from "@/server/voice/disclosure-gate";
import { upsertOwnCall } from "@/server/voice/call-rows";
import type { Locale } from "@/generated/prisma/client/client";

export const RECONCILE_CALL_BATCH = 50;
export const RECONCILE_ASSISTANT_BATCH = 25;
/** Enough for a settled-but-unprocessed call to reach its own post-call job first. */
const UNPROCESSED_GRACE_MS = 30 * 60 * 1000;
/** Vapi's own retention can be as short as 14 days. Older calls are no longer retried. */
const LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;
const DISCOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Short per read, so one slow answer can't use up a whole delivery. */
const VAPI_READ_TIMEOUT_MS = 5_000;
/** Stops well before the route's 120 s limit, and the next page continues from there. */
const WORK_BUDGET_MS = 90_000;

/** Sorts before every id, so "start again from the first assistant" is still a cursor. */
const BEFORE_FIRST_ID = "00000000-0000-0000-0000-000000000000";

/** Provider data is untrusted: an unreadable call changes nothing. */
const vapiCallSchema = z.object({
  id: z.string().min(1),
  assistantId: z.string().nullish(),
  status: z.string().nullish(),
  createdAt: z.string().nullish(),
  startedAt: z.string().nullish(),
  endedAt: z.string().nullish(),
  endedReason: z.string().nullish(),
  cost: z.number().nullish(),
  customer: z.object({ number: z.string().nullish() }).nullish(),
  artifact: z
    .object({
      messages: z.array(z.unknown()).nullish(),
      recordingUrl: z.string().nullish(),
    })
    .nullish(),
});
type VapiCall = z.infer<typeof vapiCallSchema>;

export type ReconcileResult = {
  checked: number;
  settled: number;
  requeued: number;
  discovered: number;
  /** Still unresolved, for any of the reasons logged with each. */
  unresolved: number;
  nextCallCursor: string | null;
  nextAssistantCursor: string | null;
};

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/**
 * The only ended reasons that say nobody was on the line. An allowlist: Vapi has many reasons, and
 * a missing or unfamiliar one must stay unknown rather than make a call free.
 */
const NEVER_CONNECTED_REASONS = new Set(["customer-busy", "customer-did-not-answer"]);

/** What a row already holds about a call, from a report that may have arrived without times. */
type RowEvidence = {
  startedAt: Date;
  transcript: unknown;
  recordingUrl: string | null;
  costCents: number | null;
};

function hasMessages(messages: unknown): boolean {
  return Array.isArray(messages) && messages.length > 0;
}

/**
 * Only positive evidence makes a call free: a parseable end, a stated cost of zero, no transcript
 * or recording here or on the row, and a reason that says nobody was on the line. Artifacts can
 * arrive late, and a missing cost isn't a cost of zero, so anything less stays unknown. An unknown
 * call is never billed, and stops counting against limits after UNCERTAIN_COUNTS_FOR_MS.
 */
function neverConnected(call: VapiCall, row?: RowEvidence): boolean {
  const endedMs = call.endedAt ? Date.parse(call.endedAt) : Number.NaN;
  return (
    !Number.isNaN(endedMs) &&
    call.cost === 0 &&
    !hasMessages(call.artifact?.messages) &&
    !call.artifact?.recordingUrl &&
    NEVER_CONNECTED_REASONS.has(call.endedReason ?? "") &&
    !hasMessages(row?.transcript) &&
    !row?.recordingUrl &&
    !row?.costCents
  );
}

/**
 * The length of a call Vapi says has ended. A row's start can stand in for a missing one only if
 * it gives a real length: rows created without a known start hold the call's end or the moment a
 * report arrived, which give 0 or an impossible length, and neither says the call was short.
 */
function durationFromProvider(call: VapiCall, row?: RowEvidence): number | null {
  if (call.startedAt) {
    return resolveCallDurationSeconds({ startedAt: call.startedAt, endedAt: call.endedAt });
  }
  const fromRow = row
    ? resolveCallDurationSeconds({
        startedAt: row.startedAt.toISOString(),
        endedAt: call.endedAt,
      })
    : null;
  if (fromRow !== null && fromRow > 0) return fromRow;
  return neverConnected(call, row) ? 0 : null;
}

function outcomeFromProvider(call: VapiCall, now: Date, row?: RowEvidence) {
  const endedMs = call.endedAt ? Date.parse(call.endedAt) : Number.NaN;
  return callOutcomeFields({
    endedReason: call.endedReason,
    cost: call.cost,
    durationSeconds: durationFromProvider(call, row),
    endedAt: Number.isNaN(endedMs) ? now : new Date(endedMs),
    messages: call.artifact?.messages,
    recordingUrl: call.artifact?.recordingUrl,
  });
}

/** Same job, same idempotency as a report arriving on time: nothing can be charged twice. */
async function requeuePostCall(vapiCallId: string, orgId: string, now: Date): Promise<void> {
  const bucket = Math.floor(now.getTime() / UNPROCESSED_GRACE_MS);
  await enqueue(
    "post-call",
    { vapiCallId, orgId },
    { deduplicationId: `voice-reconcile-${orgId}-${vapiCallId}-${bucket}` },
  );
}

async function fetchProviderCall(
  vapiCallId: string,
): Promise<VapiCall | "unknown" | "unavailable"> {
  try {
    const parsed = vapiCallSchema.safeParse(
      await getVapiCall(vapiCallId, AbortSignal.timeout(VAPI_READ_TIMEOUT_MS)),
    );
    return parsed.success ? parsed.data : "unavailable";
  } catch (error) {
    return error instanceof VapiHttpError && error.status === 404 ? "unknown" : "unavailable";
  }
}

async function reconcileKnownCalls(
  now: Date,
  cursor: string | undefined,
  result: ReconcileResult,
  deadlineMs: number,
): Promise<void> {
  const rows = await unscopedPrisma.voiceCall.findMany({
    where: {
      postCallProcessedAt: null,
      startedAt: { gte: new Date(now.getTime() - LOOKBACK_MS) },
      organization: { deletedAt: null },
      OR: [
        { endedAt: null, startedAt: { lt: new Date(now.getTime() - STALE_CALL_MS) } },
        { endedAt: { not: null }, durationSeconds: null },
        { endedAt: { lt: new Date(now.getTime() - UNPROCESSED_GRACE_MS) } },
      ],
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      vapiCallId: true,
      startedAt: true,
      durationSeconds: true,
      transcript: true,
      recordingUrl: true,
      costCents: true,
    },
    orderBy: { id: "asc" },
    take: RECONCILE_CALL_BATCH,
  });
  result.nextCallCursor = rows.length === RECONCILE_CALL_BATCH ? rows[rows.length - 1]!.id : null;

  let lastId: string | null = null;
  for (const row of rows) {
    // At least one per delivery, so running out of time can't loop on the same page.
    if (lastId !== null && Date.now() > deadlineMs) {
      result.nextCallCursor = lastId;
      break;
    }
    lastId = row.id;
    result.checked++;
    const ids = { orgId: row.organizationId, callId: row.id };
    const unresolvedBefore = result.unresolved;
    try {
      await reconcileKnownCall(row, ids, now, result);
    } catch (error) {
      // One bad row, such as text the database refuses, must not stop every later row.
      log("voice_reconcile_row_failed", {
        ...ids,
        error: error instanceof Error ? error.name : "unknown",
      });
      result.unresolved++;
    }
    if (
      row.durationSeconds === null &&
      result.unresolved > unresolvedBefore &&
      now.getTime() - row.startedAt.getTime() >= UNCERTAIN_COUNTS_FOR_MS
    ) {
      // No longer counted against limits, so someone should know it hasn't resolved.
      log("voice_reconcile_long_unresolved", ids);
    }
  }
}

async function reconcileKnownCall(
  row: RowEvidence & {
    id: string;
    organizationId: string;
    vapiCallId: string;
    durationSeconds: number | null;
  },
  ids: { orgId: string; callId: string },
  now: Date,
  result: ReconcileResult,
): Promise<void> {
  // A row doesn't outrank a refusal recorded for the same call, if the two ever raced. The
  // refusal is remembered for 48 hours and this row is looked at for longer, so it's closed
  // now, with no job and so no usage, rather than left to be processed once that lapses.
  const refusal = await callRefusal(row.organizationId, row.vapiCallId);
  if (refusal === "unknown") {
    log("voice_reconcile_unresolved", { ...ids, reason: "refusal_unreadable" });
    result.unresolved++;
    return;
  }
  if (refusal === "ended" || refusal === "notice") {
    await unscopedPrisma.voiceCall.updateMany({
      where: { id: row.id, organizationId: row.organizationId, postCallProcessedAt: null },
      data: { postCallProcessedAt: now },
    });
    log("voice_reconcile_refused_row_closed", ids);
    return;
  }

  // The report arrived and only its job went missing: no need to ask the provider.
  if (row.durationSeconds !== null) {
    await requeuePostCall(row.vapiCallId, row.organizationId, now);
    result.requeued++;
    return;
  }

  const call = await fetchProviderCall(row.vapiCallId);
  if (call === "unknown" || call === "unavailable") {
    log("voice_reconcile_unresolved", { ...ids, reason: call });
    result.unresolved++;
    return;
  }
  // The row's organization came from a signed webhook, so an answer naming an assistant of
  // another organization is never applied. An assistant id that nobody holds any more is
  // fine: deactivating and reactivating an assistant gives it a new id.
  const owner = call.assistantId
    ? await unscopedPrisma.voiceAssistant.findFirst({
        where: { vapiAssistantId: call.assistantId },
        select: { organizationId: true },
      })
    : null;
  if (
    call.id !== row.vapiCallId ||
    (owner !== null && owner.organizationId !== row.organizationId)
  ) {
    log("voice_reconcile_binding_mismatch", ids);
    result.unresolved++;
    return;
  }
  if (call.status !== "ended") {
    log("voice_reconcile_unresolved", { ...ids, reason: "not_ended" });
    result.unresolved++;
    return;
  }
  const outcome = outcomeFromProvider(call, now, row);
  if (outcome.durationSeconds === null) {
    log("voice_reconcile_unresolved", { ...ids, reason: "no_duration" });
    result.unresolved++;
    return;
  }
  // Conditional: a report arriving meanwhile keeps its own, equally good, details.
  await unscopedPrisma.voiceCall.updateMany({
    where: {
      id: row.id,
      organizationId: row.organizationId,
      postCallProcessedAt: null,
      durationSeconds: null,
    },
    data: outcome,
  });
  await requeuePostCall(row.vapiCallId, row.organizationId, now);
  result.settled++;
}

/** Calls Syveka never heard about at all: both the start and the end news were lost. */
async function discoverMissingCalls(
  now: Date,
  cursor: string | undefined,
  result: ReconcileResult,
  deadlineMs: number,
): Promise<void> {
  const assistants = await unscopedPrisma.voiceAssistant.findMany({
    where: {
      vapiAssistantId: { not: null },
      organization: { deletedAt: null },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: { id: true, organizationId: true, vapiAssistantId: true, language: true },
    orderBy: { id: "asc" },
    take: RECONCILE_ASSISTANT_BATCH,
  });
  result.nextAssistantCursor =
    assistants.length === RECONCILE_ASSISTANT_BATCH ? assistants[assistants.length - 1]!.id : null;

  let lastId: string | null = null;
  for (const assistant of assistants) {
    if (lastId !== null && Date.now() > deadlineMs) {
      result.nextAssistantCursor = lastId;
      break;
    }
    const resumeFrom = lastId ?? cursor ?? BEFORE_FIRST_ID;
    lastId = assistant.id;
    let listed: unknown[];
    try {
      listed = await listVapiCalls(
        assistant.vapiAssistantId as string,
        new Date(now.getTime() - DISCOVER_WINDOW_MS),
        AbortSignal.timeout(VAPI_READ_TIMEOUT_MS),
      );
    } catch {
      log("voice_reconcile_unresolved", {
        orgId: assistant.organizationId,
        assistantId: assistant.id,
        reason: "list_unavailable",
      });
      result.unresolved++;
      continue;
    }
    if (listed.length >= VAPI_CALL_LIST_LIMIT) {
      // Older calls past this page aren't seen, and could be missed if runs are too far apart.
      log("voice_reconcile_list_full", {
        orgId: assistant.organizationId,
        assistantId: assistant.id,
      });
    }
    const calls = listed.flatMap((raw) => {
      const parsed = vapiCallSchema.safeParse(raw);
      // Only this assistant's calls, whatever the provider's list returned.
      return parsed.success && parsed.data.assistantId === assistant.vapiAssistantId
        ? [parsed.data]
        : [];
    });
    if (calls.length === 0) continue;

    const known = await unscopedPrisma.voiceCall.findMany({
      where: { vapiCallId: { in: calls.map((c) => c.id) } },
      select: { vapiCallId: true },
    });
    const knownIds = new Set(known.map((k) => k.vapiCallId));

    let attempted = false;
    let keptAny = false;
    for (const call of calls) {
      if (knownIds.has(call.id) || call.status !== "ended") continue;
      // Its report may still be on the way, and it carries the transcript and recording.
      const endedMs = call.endedAt ? Date.parse(call.endedAt) : Number.NaN;
      if (!Number.isNaN(endedMs) && now.getTime() - endedMs < UNPROCESSED_GRACE_MS) continue;
      // Each call can mean more slow reads, so the budget is also checked here. Calls already
      // kept are skipped next time, so resuming this assistant makes progress. If some were tried
      // and none kept, moving on stops one assistant starving the rest; its calls come up again
      // on the next run. If none was tried, this assistant hasn't had its turn yet.
      if (Date.now() > deadlineMs) {
        log("voice_reconcile_unresolved", {
          orgId: assistant.organizationId,
          assistantId: assistant.id,
          reason: "out_of_time",
        });
        result.unresolved++;
        result.nextAssistantCursor = attempted && !keptAny ? assistant.id : resumeFrom;
        return;
      }
      attempted = true;
      try {
        if (await discoverCall(call, assistant, now, result)) {
          keptAny = true;
          result.discovered++;
        }
      } catch (error) {
        log("voice_reconcile_row_failed", {
          orgId: assistant.organizationId,
          assistantId: assistant.id,
          vapiCallId: call.id,
          error: error instanceof Error ? error.name : "unknown",
        });
        result.unresolved++;
      }
    }
  }
}

/** One call Syveka never heard of. True if a row was kept for it. */
async function discoverCall(
  call: VapiCall,
  assistant: {
    id: string;
    organizationId: string;
    vapiAssistantId: string | null;
    language: Locale;
  },
  now: Date,
  result: ReconcileResult,
): Promise<boolean> {
  // Syveka ended this call itself and kept no row for it: it isn't the customer's usage.
  // If that can't be read, leave it for the next run, rather than bill a refused call.
  const refusal = await callRefusal(assistant.organizationId, call.id);
  if (refusal === "ended" || refusal === "notice" || refusal === "unknown") return false;
  // Without a stored confirmation, only this call's own record can confirm its notice: a
  // config read now can't show what its caller heard. That includes a call refused by limits
  // that really ran. Unreadable state, or a record that can't say yet, waits for the next run.
  let messages: unknown = call.artifact?.messages;
  const notice = await callDisclosureState(assistant.organizationId, call.id);
  if (notice === "unknown") return false;
  if (notice === "unverified") {
    const judged = await confirmNoticeFromCallRecord({
      orgId: assistant.organizationId,
      vapiCallId: call.id,
      language: assistant.language,
      vapiAssistantId: assistant.vapiAssistantId as string,
      messages: call.artifact?.messages,
      calledAt: earliestCallTime(call.startedAt, call.createdAt),
      now,
    });
    const confirmation = judged.outcome;
    if (Array.isArray(judged.messages)) messages = judged.messages;
    if (confirmation === "contradicted") {
      // Recorded, so nothing later can bring this call back. If that fails, the next run
      // reaches the same answer from the same record.
      await markCallRefused(assistant.organizationId, call.id, "notice");
      log("voice_reconcile_without_notice", {
        orgId: assistant.organizationId,
        vapiCallId: call.id,
      });
      return false;
    }
    if (confirmation !== "ok") {
      log("voice_reconcile_unresolved", {
        orgId: assistant.organizationId,
        vapiCallId: call.id,
        reason: "no_notice_evidence",
      });
      result.unresolved++;
      return false;
    }
  }
  const outcome = outcomeFromProvider(
    { ...call, artifact: { ...call.artifact, messages: messages as unknown[] | undefined } },
    now,
  );
  const startedMs = call.startedAt ? Date.parse(call.startedAt) : Number.NaN;
  const written = await upsertOwnCall(unscopedPrisma, assistant.organizationId, {
    vapiCallId: call.id,
    create: {
      organizationId: assistant.organizationId,
      assistantId: assistant.id,
      vapiCallId: call.id,
      callerNumber: call.customer?.number ?? undefined,
      startedAt: Number.isNaN(startedMs) ? outcome.endedAt : new Date(startedMs),
      ...outcome,
    },
    update: {},
  });
  if (written === "foreign") return false;
  if (outcome.durationSeconds !== null) {
    await requeuePostCall(call.id, assistant.organizationId, now);
  }
  return true;
}

/**
 * Recovers calls whose webhooks were lost or late: finds what is unsettled, asks Vapi, and
 * feeds the answer through the same idempotent post-call job. It only reads from Vapi. A row
 * it can't resolve stays uncertain: never billed, and counted against limits for
 * UNCERTAIN_COUNTS_FOR_MS. A call with no row and no evidence isn't kept, counted or billed.
 */
export async function reconcileVoiceCalls(
  options: {
    now?: Date;
    callCursor?: string;
    assistantCursor?: string;
    /** A scan already finished in this chain: without this it would restart from page one. */
    callsDone?: boolean;
    assistantsDone?: boolean;
    deadlineMs?: number;
  } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const result: ReconcileResult = {
    checked: 0,
    settled: 0,
    requeued: 0,
    discovered: 0,
    unresolved: 0,
    nextCallCursor: null,
    nextAssistantCursor: null,
  };
  const deadlineMs = options.deadlineMs ?? Date.now() + WORK_BUDGET_MS;
  if (!options.callsDone) await reconcileKnownCalls(now, options.callCursor, result, deadlineMs);
  if (!options.assistantsDone) {
    await discoverMissingCalls(now, options.assistantCursor, result, deadlineMs);
  }
  return result;
}
