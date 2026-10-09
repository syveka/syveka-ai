import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client/client";
import type { unscopedPrisma as prismaClient } from "@/server/db/tenant";
import type { ToolIdentity } from "@/server/ai/tools";
import type { redis as redisClient } from "@/server/integrations/redis";
import { allowedVoiceTools } from "@/lib/validators/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Single Vapi server-events endpoint (§16.1):
 *  - tool-calls   → execute against the shared tool registry, <800ms budget
 *  - status-update / end-of-call-report → call lifecycle persistence
 */
const messageSchema = z.object({
  message: z.object({
    type: z.string(),
    call: z
      .object({
        id: z.string(),
        assistantId: z.string().optional(),
        customer: z.object({ number: z.string().optional() }).optional(),
      })
      .optional(),
    toolCallList: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.unknown()).optional(),
        }),
      )
      .optional(),
    status: z.string().optional(),
    endedReason: z.string().optional(),
    durationSeconds: z.number().optional(),
    cost: z.number().optional(),
    artifact: z
      .object({
        transcript: z.string().optional(),
        messages: z.array(z.unknown()).optional(),
        recordingUrl: z.string().optional(),
      })
      .optional(),
  }),
});

/**
 * Per-call caps on the voice tools that write tenant data. An anonymous caller (or a
 * script dialling in) otherwise could book every offered slot or create unlimited
 * contacts/activities in one call. Owner-tunable defaults; read tools are not capped.
 */
const VOICE_CALL_WRITE_CAPS: ReadonlyMap<string, number> = new Map([
  ["bookMeeting", 2],
  ["createContact", 2],
  ["logActivity", 5],
]);
// Outlives the longest possible call (maxDurationSeconds 900, src/server/services/voice.ts).
const CALL_WRITE_CAP_TTL_SECONDS = 60 * 60 * 2;

async function resolveAssistant(
  unscopedPrisma: typeof prismaClient,
  vapiAssistantId: string | undefined,
) {
  if (!vapiAssistantId) return null;
  return unscopedPrisma.voiceAssistant.findFirst({
    // A soft-deleted org's assistant is treated as unknown: nothing is ingested.
    where: { vapiAssistantId, organization: { deletedAt: null } },
    select: {
      id: true,
      organizationId: true,
      enabledTools: true,
      useKnowledgeBase: true,
      isActive: true,
      organization: {
        select: { members: { where: { role: "OWNER" }, select: { userId: true }, take: 1 } },
      },
    },
  });
}

/**
 * Counts one write against the call's cap for this tool. Returns the refusal code, or
 * null when the write may proceed. Fails closed: if Redis cannot count the write, it is
 * refused (and the tool-call claim released best-effort so a retry can run later). A
 * write refused by the cap gives its slot back so it never consumes capacity, but keeps
 * the tool-call claim: the assistant was told it failed, so that tool-call id must not
 * run later on a retry or replay either.
 */
async function reserveCallWrite(
  redis: typeof redisClient,
  capKey: string,
  cap: number,
  claimKey: string,
): Promise<"call_write_limit" | "call_write_limit_unavailable" | null> {
  let count: number;
  try {
    count = await redis.incr(capKey);
    if (count === 1) await redis.expire(capKey, CALL_WRITE_CAP_TTL_SECONDS);
  } catch {
    await redis.del(claimKey).catch(() => undefined);
    return "call_write_limit_unavailable";
  }
  if (count > cap) {
    await redis.decr(capKey);
    return "call_write_limit";
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { verifyVapiSignature },
    { unscopedPrisma },
    { executeTool },
    { getMonthUsage, getEntitlements },
    { enqueue },
    { redis },
  ] = await Promise.all([
    import("@/server/integrations/vapi"),
    import("@/server/db/tenant"),
    import("@/server/ai/tools"),
    import("@/server/services/billing/entitlements"),
    import("@/server/jobs/queue"),
    import("@/server/integrations/redis"),
  ]);

  const rawBody = await request.text();
  const signature = request.headers.get("x-vapi-signature") ?? request.headers.get("x-vapi-secret");
  if (!verifyVapiSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const parsed = messageSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { message } = parsed.data;

  const assistant = await resolveAssistant(unscopedPrisma, message.call?.assistantId);
  if (!assistant) return NextResponse.json({ error: "unknown assistant" }, { status: 404 });
  const orgId = assistant.organizationId;
  const ownerUserId = assistant.organization.members[0]?.userId ?? "";

  switch (message.type) {
    // ── In-call tool execution (§16.3) ──
    case "tool-calls": {
      // Defense in depth for deactivateAssistant() (src/server/services/
      // voice.ts): the primary containment there deletes the Vapi assistant
      // so it stops answering entirely, but that is a best-effort external
      // call and cannot be guaranteed atomic with the DB-side isActive flag
      // -- a call already in progress at the exact moment of deactivation
      // must still be refused a write here, not just future calls.
      if (!assistant.isActive) {
        const results = (message.toolCallList ?? []).map((tc) => ({
          toolCallId: tc.id,
          result: JSON.stringify({ error: "assistant_disabled" }),
        }));
        return NextResponse.json({ results });
      }

      // Voice acts as a restricted MANAGER-level service identity limited to
      // its enabledTools (§15.4).
      const identity: ToolIdentity = {
        orgId,
        userId: ownerUserId,
        role: "MANAGER",
        actorType: "voice_ai",
      };
      const enabled = new Set(
        allowedVoiceTools(assistant.enabledTools, assistant.useKnowledgeBase),
      );

      // Replay guard: the HMAC covers the body but carries no timestamp, so a
      // captured tool-calls request stays validly signed forever. Each Vapi
      // tool-call id runs at most once -- a replay (or a retry after the first
      // attempt already ran) must not repeat a booking or return tool output
      // to whoever re-sent it. Claimed atomically before executing, released
      // if execution throws so a legitimate retry can still run it.
      //
      // Writes are additionally bounded per call (VOICE_CALL_WRITE_CAPS) and refused
      // once the call has ended -- the Redis claim expires after 24h, so the durable
      // VoiceCall row is what stops a later replay. Both are keyed by the signed
      // call id within the signed assistant's org.
      const callId = message.call?.id;
      const hasWrite = (message.toolCallList ?? []).some(
        (tc) => enabled.has(tc.name) && VOICE_CALL_WRITE_CAPS.has(tc.name),
      );
      // A missing row is allowed: the in-progress status update can be missed.
      const callRow =
        hasWrite && callId
          ? await unscopedPrisma.voiceCall.findFirst({
              where: { organizationId: orgId, vapiCallId: callId },
              select: { endedAt: true, status: true },
            })
          : null;
      const callEnded = Boolean(callRow && (callRow.endedAt || callRow.status !== "IN_PROGRESS"));

      const results = await Promise.all(
        (message.toolCallList ?? []).map(async (tc) => {
          if (!enabled.has(tc.name)) {
            return { toolCallId: tc.id, result: JSON.stringify({ error: "tool_not_enabled" }) };
          }
          const cap = VOICE_CALL_WRITE_CAPS.get(tc.name);
          if (cap !== undefined && (!callId || callEnded)) {
            const error = callId ? "call_ended" : "call_required";
            return { toolCallId: tc.id, result: JSON.stringify({ error }) };
          }
          const claimKey = `vapi:tool:${orgId}:${tc.id}`;
          const claimed = await redis.set(claimKey, "1", { nx: true, ex: 60 * 60 * 24 });
          if (claimed === null) {
            return { toolCallId: tc.id, result: JSON.stringify({ error: "duplicate_tool_call" }) };
          }
          const capKey = cap === undefined ? null : `vapi:callcap:${orgId}:${callId}:${tc.name}`;
          if (cap !== undefined && capKey) {
            const refusal = await reserveCallWrite(redis, capKey, cap, claimKey);
            if (refusal) return { toolCallId: tc.id, result: JSON.stringify({ error: refusal }) };
          }
          try {
            return {
              toolCallId: tc.id,
              result: await executeTool(identity, tc.name, tc.arguments ?? {}),
            };
          } catch (err) {
            await redis.del(claimKey);
            if (capKey) await redis.decr(capKey);
            throw err;
          }
        }),
      );
      return NextResponse.json({ results });
    }

    // ── Call started: entitlement gate + record (§14.2) ──
    case "status-update": {
      if (message.status === "in-progress" && message.call) {
        const [used, ent] = await Promise.all([
          getMonthUsage(orgId, "VOICE_MINUTES"),
          getEntitlements(orgId),
        ]);
        if (used >= ent.voiceMinutesMonth) {
          // over quota → instruct Vapi to end the call
          return NextResponse.json({ action: "end-call" });
        }
        await unscopedPrisma.voiceCall.upsert({
          where: { vapiCallId: message.call.id },
          create: {
            organizationId: orgId,
            assistantId: assistant.id,
            vapiCallId: message.call.id,
            callerNumber: message.call.customer?.number,
            startedAt: new Date(),
            status: "IN_PROGRESS",
          },
          update: {},
        });
      }
      return NextResponse.json({ ok: true });
    }

    // ── Call ended: persist + hand off to post-call pipeline (§16.4) ──
    case "end-of-call-report": {
      if (!message.call) return NextResponse.json({ ok: true });
      const durationSeconds = Math.round(message.durationSeconds ?? 0);
      // The same call details whether or not the in-progress status update was received:
      // post-call bills from durationSeconds and summarizes the transcript.
      const callResult = {
        status: message.endedReason === "assistant-forwarded-call" ? "TRANSFERRED" : "COMPLETED",
        endedAt: new Date(),
        durationSeconds,
        costCents: Math.round((message.cost ?? 0) * 100),
        endedReason: message.endedReason,
        transcript: message.artifact?.messages as Prisma.InputJsonValue | undefined,
        recordingUrl: message.artifact?.recordingUrl,
      } as const;

      // A validly-signed report never expires, so a replay must not rewrite the
      // details of a call that has already ended (endedAt, transcript, cost...).
      const existing = await unscopedPrisma.voiceCall.findFirst({
        where: { organizationId: orgId, vapiCallId: message.call.id },
        select: { endedAt: true, postCallProcessedAt: true },
      });
      if (existing?.postCallProcessedAt) {
        // Fully processed already: nothing to persist and nothing to re-enqueue.
        return NextResponse.json({ ok: true, duplicate: true });
      }
      // Ended but not yet processed (e.g. the first delivery's enqueue failed): keep the
      // recorded details and fall through so a legitimate retry can still enqueue.
      if (!existing?.endedAt) {
        await unscopedPrisma.voiceCall.upsert({
          where: { vapiCallId: message.call.id },
          create: {
            organizationId: orgId,
            assistantId: assistant.id,
            vapiCallId: message.call.id,
            callerNumber: message.call.customer?.number,
            startedAt: new Date(Date.now() - durationSeconds * 1000),
            ...callResult,
          },
          update: callResult,
        });
      }

      // Replay/idempotency guard for the post-call side effect only — the voiceCall
      // persistence above is already safe to repeat. A validly-signed end-of-call-report
      // has no expiry, so Vapi retries (or a captured-and-replayed request) could
      // otherwise re-trigger the post-call pipeline indefinitely.
      //
      // QStash's own deduplicationId covers concurrent/uncertain-ack deliveries; the
      // durable Redis marker below covers replays outside QStash's window. The marker
      // is written only *after* enqueue succeeds, so a failed enqueue never gets
      // marked complete — a legitimate retry must still be able to enqueue.
      const dedupeKey = `vapi:eocr:${orgId}:${message.call.id}`;
      const alreadyProcessed = await redis.get(dedupeKey);
      if (alreadyProcessed) {
        return NextResponse.json({ ok: true, duplicate: true });
      }

      try {
        await enqueue(
          "post-call",
          { vapiCallId: message.call.id, orgId },
          { deduplicationId: `vapi-eocr-${orgId}-${message.call.id}` },
        );
      } catch {
        // Do not mark the event complete: a legitimate retry must be able to enqueue.
        return NextResponse.json({ error: "post-call enqueue failed" }, { status: 500 });
      }

      await redis.set(dedupeKey, "1", { ex: 60 * 60 * 24 });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ ok: true });
  }
}
