import "server-only";

import { z } from "zod";
import { unscopedPrisma } from "@/server/db/tenant";
import { getVapiCall, listVapiCalls, VapiHttpError } from "@/server/integrations/vapi";
import { enqueue } from "@/server/jobs/queue";
import { STALE_CALL_MS } from "@/server/services/billing/voice-usage";
import { callRefusal, markCallRefused } from "@/server/voice/call-admission";
import { callOutcomeFields, resolveCallDurationSeconds } from "@/server/voice/call-outcome";
import {
  callDisclosureState,
  confirmNoticeFromCallRecord,
  earliestCallTime,
} from "@/server/voice/disclosure-gate";
import { upsertOwnCall } from "@/server/voice/call-rows";

export const RECONCILE_CALL_BATCH = 50;
export const RECONCILE_ASSISTANT_BATCH = 25;
/** Enough for a settled-but-unprocessed call to reach its own post-call job first. */
const UNPROCESSED_GRACE_MS = 30 * 60 * 1000;
/** Vapi's own retention can be as short as 14 days; older calls stay reported as uncertain. */
const LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;
const DISCOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Short per read, so one slow answer can't use up a whole delivery. */
const VAPI_READ_TIMEOUT_MS = 5_000;
/** Stops well before the route's 120 s limit, and the next page continues from there. */
const WORK_BUDGET_MS = 90_000;

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
 * A call Vapi says has ended and never started had no minutes: that is a fact, not a gap. But
 * a row proves the call did connect, and then its own start time gives the length.
 */
function durationFromProvider(call: VapiCall, rowStartedAt?: Date): number | null {
  const startedAt = call.startedAt ?? rowStartedAt?.toISOString();
  if (!startedAt && call.endedAt) return 0;
  return resolveCallDurationSeconds({ startedAt, endedAt: call.endedAt });
}

function outcomeFromProvider(call: VapiCall, now: Date, rowStartedAt?: Date) {
  const endedMs = call.endedAt ? Date.parse(call.endedAt) : Number.NaN;
  return callOutcomeFields({
    endedReason: call.endedReason,
    cost: call.cost,
    durationSeconds: durationFromProvider(call, rowStartedAt),
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

    // A row doesn't outrank a refusal recorded for the same call, if the two ever raced. The
    // refusal is remembered for 48 hours and this row is looked at for longer, so it's closed
    // now, with no job and so no usage, rather than left to be processed once that lapses.
    const refusal = await callRefusal(row.organizationId, row.vapiCallId);
    if (refusal === "unknown") {
      log("voice_reconcile_unresolved", { ...ids, reason: "refusal_unreadable" });
      result.unresolved++;
      continue;
    }
    if (refusal === "ended" || refusal === "notice") {
      await unscopedPrisma.voiceCall.updateMany({
        where: { id: row.id, organizationId: row.organizationId, postCallProcessedAt: null },
        data: { postCallProcessedAt: now },
      });
      log("voice_reconcile_refused_row_closed", ids);
      continue;
    }

    // The report arrived and only its job went missing: no need to ask the provider.
    if (row.durationSeconds !== null) {
      await requeuePostCall(row.vapiCallId, row.organizationId, now);
      result.requeued++;
      continue;
    }

    const call = await fetchProviderCall(row.vapiCallId);
    if (call === "unknown" || call === "unavailable") {
      log("voice_reconcile_unresolved", { ...ids, reason: call });
      result.unresolved++;
      continue;
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
      continue;
    }
    if (call.status !== "ended") {
      log("voice_reconcile_unresolved", { ...ids, reason: "not_ended" });
      result.unresolved++;
      continue;
    }
    const outcome = outcomeFromProvider(call, now, row.startedAt);
    if (outcome.durationSeconds === null) {
      log("voice_reconcile_unresolved", { ...ids, reason: "no_duration" });
      result.unresolved++;
      continue;
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

    for (const call of calls) {
      if (knownIds.has(call.id) || call.status !== "ended") continue;
      // Each call below can read from Vapi. What's left waits for the next scheduled run.
      if (Date.now() > deadlineMs) {
        log("voice_reconcile_unresolved", {
          orgId: assistant.organizationId,
          assistantId: assistant.id,
          reason: "out_of_time",
        });
        result.unresolved++;
        break;
      }
      // Syveka ended this call itself and kept no row for it: it isn't the customer's usage.
      // If that can't be read, leave it for the next run, rather than bill a refused call.
      const refusal = await callRefusal(assistant.organizationId, call.id);
      if (refusal === "ended" || refusal === "notice" || refusal === "unknown") continue;
      // Without a stored confirmation, only this call's own record can confirm its notice: a
      // config read now can't show what its caller heard. That includes a call refused by limits
      // that really ran. Unreadable state, or a record that can't say yet, waits for the next run.
      let messages: unknown = call.artifact?.messages;
      const notice = await callDisclosureState(assistant.organizationId, call.id);
      if (notice === "unknown") continue;
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
          continue;
        }
        if (confirmation !== "ok") {
          log("voice_reconcile_unresolved", {
            orgId: assistant.organizationId,
            vapiCallId: call.id,
            reason: "no_notice_evidence",
          });
          result.unresolved++;
          continue;
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
      if (written === "foreign") continue;
      result.discovered++;
      if (outcome.durationSeconds !== null) {
        await requeuePostCall(call.id, assistant.organizationId, now);
      }
    }
  }
}

/**
 * Recovers calls whose webhooks were lost or late: finds what is unsettled, asks Vapi, and
 * feeds the answer through the same idempotent post-call job. It only reads from Vapi. A row
 * it can't resolve stays uncertain: counted against limits, never billed. A call with no row
 * and no evidence isn't kept, counted or billed.
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
