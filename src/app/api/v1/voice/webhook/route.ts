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
/** Tool arguments as an object: Vapi's spec sends them as a JSON string. */
function toolArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === "") return {};
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One requested tool call, normalized to { id, name, arguments }. Vapi's API
 * spec (ToolCall) nests the call as `function: { name, arguments }` with the
 * arguments as a JSON string; some of its docs examples show a flat
 * `{ name, arguments | parameters }`. Both are accepted. `arguments` is null
 * when they can't be read as an object: such a call is refused, never run
 * with guessed input.
 */
const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
    parameters: z.unknown().optional(),
    function: z.object({ name: z.string(), arguments: z.unknown().optional() }).optional(),
  })
  .transform((tc) => ({
    id: tc.id,
    name: tc.function?.name ?? tc.name ?? "",
    arguments: toolArguments(tc.function ? tc.function.arguments : (tc.arguments ?? tc.parameters)),
  }));

/**
 * A turn asks for a handful of tools; a signed request carrying hundreds would
 * fan out that many claims, DB lookups and paid KB searches at once.
 */
const MAX_TOOL_CALLS_PER_REQUEST = 20;

const messageSchema = z.object({
  message: z.object({
    type: z.string(),
    call: z
      .object({
        id: z.string(),
        assistantId: z.string().optional(),
        customer: z.object({ number: z.string().optional() }).optional(),
        // Live Call Control URL. Unauthenticated unless the assistant enables
        // monitorPlan.controlAuthenticationEnabled, so it is treated as a secret.
        monitor: z.object({ controlUrl: z.string().nullish() }).nullish(),
      })
      .optional(),
    toolCallList: z.array(toolCallSchema).max(MAX_TOOL_CALLS_PER_REQUEST).optional(),
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
      language: true,
      organization: {
        select: { members: { where: { role: "OWNER" }, select: { userId: true }, take: 1 } },
      },
    },
  });
}

/**
 * Usage is recorded only after a call ends, so calls running in parallel all
 * pass this check until the first of them is billed.
 */
async function voiceQuotaExceeded(orgId: string): Promise<boolean> {
  const { getMonthUsage, getEntitlements } = await import("@/server/services/billing/entitlements");
  const [used, ent] = await Promise.all([
    getMonthUsage(orgId, "VOICE_MINUTES"),
    getEntitlements(orgId),
  ]);
  return used >= ent.voiceMinutesMonth;
}

/** Spoken before an over-quota call ends, in the assistant's language. */
const QUOTA_EXCEEDED_GOODBYE: Record<"FI" | "EN" | "AR", string> = {
  FI: "Valitettavasti tämä linja ei voi juuri nyt ottaa vastaan puheluita. Näkemiin.",
  EN: "Sorry, this line can't take more calls right now. Goodbye.",
  AR: "عذرًا، لا يمكن لهذا الخط استقبال مكالمات أخرى الآن. مع السلامة.",
};

const END_CALL_TIMEOUT_MS = 3_000;

/** Vapi's own hosts over https only: the body is signed, but it never picks an arbitrary fetch target. */
function isVapiControlUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    (url.hostname === "vapi.ai" || url.hostname.endsWith(".vapi.ai"))
  );
}

/**
 * Vapi ignores any reply to a status-update, so ending a call has to go through
 * Live Call Control. Failure-tolerant: the webhook still answers 200. Logs ids
 * and the error class only; the control URL is a capability and never logged.
 */
async function endCallViaControlUrl(
  controlUrl: string | null | undefined,
  ids: { orgId: string; vapiCallId: string },
): Promise<void> {
  if (!controlUrl || !isVapiControlUrl(controlUrl)) {
    console.warn(
      JSON.stringify({
        event: "voice_quota_end_call_skipped",
        reason: controlUrl ? "invalid_control_url" : "missing_control_url",
        ...ids,
      }),
    );
    return;
  }
  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "end-call" }),
      redirect: "error",
      signal: AbortSignal.timeout(END_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({ event: "voice_quota_end_call_failed", status: res.status, ...ids }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "voice_quota_end_call_failed",
        name: err instanceof Error ? err.name : "unknown",
        ...ids,
      }),
    );
  }
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
  let count: number | null = null;
  try {
    count = await redis.incr(capKey);
    if (count === 1) await redis.expire(capKey, CALL_WRITE_CAP_TTL_SECONDS);
  } catch {
    // Counted but not given a TTL: give the slot back too (best effort).
    if (count !== null) await releaseCallWrite(redis, capKey);
    await redis.del(claimKey).catch(() => undefined);
    return "call_write_limit_unavailable";
  }
  if (count > cap) {
    await releaseCallWrite(redis, capKey);
    return "call_write_limit";
  }
  return null;
}

/** Gives a counted write's slot back. Best effort: a failure only makes the cap stricter. */
async function releaseCallWrite(redis: typeof redisClient, capKey: string): Promise<void> {
  await redis.decr(capKey).catch(() => undefined);
}

/**
 * Refusals that executeTool (or the tool) returns before anything is written.
 * executeTool reports failures as results, it doesn't throw. `execution_failed`
 * is deliberately absent: a tool can fail after its write (e.g. the audit insert
 * after the booking or contact was created), so that attempt keeps its slot.
 */
const PRE_WRITE_REFUSALS = new Set([
  "invalid_input",
  "permission_denied",
  "unknown_tool",
  "entitlement_exceeded",
]);

/**
 * Whether a tool result says nothing was written: a pre-write refusal, or a
 * booking that didn't happen (`{ booked: false }`, e.g. the slot was taken).
 * Such an attempt gives its cap slot back, so a caller retrying a failed
 * booking isn't locked out of the call's legitimate writes.
 */
function wroteNothing(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed !== "object" || parsed === null) return false;
    const { error, booked } = parsed as { error?: unknown; booked?: unknown };
    return booked === false || (typeof error === "string" && PRE_WRITE_REFUSALS.has(error));
  } catch {
    return false;
  }
}

/**
 * What the caller's assistant may hear back from a tool. Error results keep only
 * their stable code: executeTool's execution_failed carries the raw error message
 * (Prisma text naming models, fields and input) and invalid_input carries
 * validation details, and the model can read either out to an anonymous caller.
 */
function callerSafeResult(result: string): string {
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const { error } = parsed as { error?: unknown };
      if (typeof error === "string") return JSON.stringify({ error });
    }
  } catch {
    // Not JSON: pass through unchanged (tool results are always JSON today).
  }
  return result;
}

export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyVapiSignature }, { unscopedPrisma }, { executeTool }, { enqueue }, { redis }] =
    await Promise.all([
      import("@/server/integrations/vapi"),
      import("@/server/db/tenant"),
      import("@/server/ai/tools"),
      import("@/server/jobs/queue"),
      import("@/server/integrations/redis"),
    ]);

  const rawBody = await request.text();
  const signature = request.headers.get("x-vapi-signature") ?? request.headers.get("x-vapi-secret");
  if (!verifyVapiSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  const parsed = messageSchema.safeParse(body);
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

      // Over quota: run no tool, say goodbye and end the call. Vapi acts on this
      // reply and ends the call once the line is spoken (endCallAfterSpokenEnabled).
      // Live Call Control is not used here: it would hang up before the goodbye.
      if (await voiceQuotaExceeded(orgId)) {
        const content = QUOTA_EXCEEDED_GOODBYE[assistant.language] ?? QUOTA_EXCEEDED_GOODBYE.EN;
        const results = (message.toolCallList ?? []).map((tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          error: "quota_exceeded",
          message: { type: "request-failed", content, endCallAfterSpokenEnabled: true },
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
        (message.toolCallList ?? []).map((tc) =>
          (async () => {
            if (!enabled.has(tc.name)) {
              return { toolCallId: tc.id, result: JSON.stringify({ error: "tool_not_enabled" }) };
            }
            if (tc.arguments === null) {
              return { toolCallId: tc.id, result: JSON.stringify({ error: "invalid_arguments" }) };
            }
            const cap = VOICE_CALL_WRITE_CAPS.get(tc.name);
            if (cap !== undefined && (!callId || callEnded)) {
              const error = callId ? "call_ended" : "call_required";
              return { toolCallId: tc.id, result: JSON.stringify({ error }) };
            }
            const claimKey = `vapi:tool:${orgId}:${tc.id}`;
            const claimed = await redis.set(claimKey, "1", { nx: true, ex: 60 * 60 * 24 });
            if (claimed === null) {
              return {
                toolCallId: tc.id,
                result: JSON.stringify({ error: "duplicate_tool_call" }),
              };
            }
            const capKey = cap === undefined ? null : `vapi:callcap:${orgId}:${callId}:${tc.name}`;
            if (cap !== undefined && capKey) {
              const refusal = await reserveCallWrite(redis, capKey, cap, claimKey);
              if (refusal) return { toolCallId: tc.id, result: JSON.stringify({ error: refusal }) };
            }
            try {
              const result = await executeTool(identity, tc.name, tc.arguments);
              if (capKey && wroteNothing(result)) await releaseCallWrite(redis, capKey);
              return { toolCallId: tc.id, result: callerSafeResult(result) };
            } catch (err) {
              if (capKey) await releaseCallWrite(redis, capKey);
              await redis.del(claimKey).catch(() => undefined);
              throw err;
            }
          })().catch((err: unknown) => {
            // One tool call failing (e.g. Redis unreachable for its claim) must not fail
            // the others in the batch: their results -- a booking already made -- still
            // reach the caller. This one is refused without detail (fails closed).
            console.error(
              JSON.stringify({
                event: "voice_tool_call_failed",
                orgId,
                toolCallId: tc.id,
                name: err instanceof Error ? err.name : "unknown",
              }),
            );
            return { toolCallId: tc.id, result: JSON.stringify({ error: "tool_unavailable" }) };
          }),
        ),
      );
      return NextResponse.json({ results });
    }

    // ── Call started: entitlement gate + record (§14.2) ──
    case "status-update": {
      if (message.status === "in-progress" && message.call) {
        if (await voiceQuotaExceeded(orgId)) {
          // Over quota: no call row, and end the call through Live Call Control
          // (Vapi does not act on a reply to status-update).
          await endCallViaControlUrl(message.call.monitor?.controlUrl, {
            orgId,
            vapiCallId: message.call.id,
          });
          return NextResponse.json({ ok: true });
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
