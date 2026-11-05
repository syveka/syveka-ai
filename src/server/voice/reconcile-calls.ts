import "server-only";

import { z } from "zod";
import { unscopedPrisma } from "@/server/db/tenant";
import { getVapiCall, listVapiCalls, VapiHttpError } from "@/server/integrations/vapi";
import { enqueue } from "@/server/jobs/queue";
import { STALE_CALL_MS } from "@/server/services/billing/voice-usage";
import { wasCallRefused } from "@/server/voice/call-admission";
import { callOutcomeFields, resolveCallDurationSeconds } from "@/server/voice/call-outcome";
import { upsertOwnCall } from "@/server/voice/call-rows";

export const RECONCILE_CALL_BATCH = 50;
export const RECONCILE_ASSISTANT_BATCH = 25;
/** Enough for a settled-but-unprocessed call to reach its own post-call job first. */
const UNPROCESSED_GRACE_MS = 30 * 60 * 1000;
/** Vapi's own retention can be as short as 14 days; older calls stay reported as uncertain. */
const LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;
const DISCOVER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Provider data is untrusted: an unreadable call changes nothing. */
const vapiCallSchema = z.object({
  id: z.string().min(1),
  assistantId: z.string().nullish(),
  status: z.string().nullish(),
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
  /** Still unresolved: Vapi was unreachable, has no such call, or the call hasn't ended. */
  unresolved: number;
  nextCallCursor: string | null;
  nextAssistantCursor: string | null;
};

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/** A call Vapi says has ended and never started had no minutes: that is a fact, not a gap. */
function durationFromProvider(call: VapiCall): number | null {
  if (!call.startedAt && call.endedAt) return 0;
  return resolveCallDurationSeconds({ startedAt: call.startedAt, endedAt: call.endedAt });
}

function outcomeFromProvider(call: VapiCall, now: Date) {
  const endedMs = call.endedAt ? Date.parse(call.endedAt) : Number.NaN;
  return callOutcomeFields({
    endedReason: call.endedReason,
    cost: call.cost,
    durationSeconds: durationFromProvider(call),
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
    const parsed = vapiCallSchema.safeParse(await getVapiCall(vapiCallId));
    return parsed.success ? parsed.data : "unavailable";
  } catch (error) {
    return error instanceof VapiHttpError && error.status === 404 ? "unknown" : "unavailable";
  }
}

async function reconcileKnownCalls(
  now: Date,
  cursor: string | undefined,
  result: ReconcileResult,
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
      durationSeconds: true,
      assistant: { select: { vapiAssistantId: true } },
    },
    orderBy: { id: "asc" },
    take: RECONCILE_CALL_BATCH,
  });
  result.nextCallCursor = rows.length === RECONCILE_CALL_BATCH ? rows[rows.length - 1]!.id : null;

  for (const row of rows) {
    result.checked++;
    const ids = { orgId: row.organizationId, callId: row.id };

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
    // The row's binding came from a signed webhook. A provider answer contradicting it is
    // never applied. An assistant since deactivated has no id left to compare.
    const boundAssistant = row.assistant.vapiAssistantId;
    if (call.id !== row.vapiCallId || (boundAssistant && call.assistantId !== boundAssistant)) {
      log("voice_reconcile_binding_mismatch", ids);
      result.unresolved++;
      continue;
    }
    if (call.status !== "ended") {
      log("voice_reconcile_unresolved", { ...ids, reason: "not_ended" });
      result.unresolved++;
      continue;
    }
    const outcome = outcomeFromProvider(call, now);
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
): Promise<void> {
  const assistants = await unscopedPrisma.voiceAssistant.findMany({
    where: {
      vapiAssistantId: { not: null },
      organization: { deletedAt: null },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: { id: true, organizationId: true, vapiAssistantId: true },
    orderBy: { id: "asc" },
    take: RECONCILE_ASSISTANT_BATCH,
  });
  result.nextAssistantCursor =
    assistants.length === RECONCILE_ASSISTANT_BATCH ? assistants[assistants.length - 1]!.id : null;

  for (const assistant of assistants) {
    let listed: unknown[];
    try {
      listed = await listVapiCalls(
        assistant.vapiAssistantId as string,
        new Date(now.getTime() - DISCOVER_WINDOW_MS),
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
      // Syveka ended this call itself and kept no row for it: it isn't the customer's usage.
      if (await wasCallRefused(assistant.organizationId, call.id)) continue;
      const outcome = outcomeFromProvider(call, now);
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
 * feeds the answer through the same idempotent post-call job. It only reads from Vapi. A
 * call it can't resolve stays uncertain: counted against limits, never billed.
 */
export async function reconcileVoiceCalls(
  options: { now?: Date; callCursor?: string; assistantCursor?: string } = {},
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
  await reconcileKnownCalls(now, options.callCursor, result);
  await discoverMissingCalls(now, options.assistantCursor, result);
  return result;
}
