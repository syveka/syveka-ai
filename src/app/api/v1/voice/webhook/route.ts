import { NextResponse } from "next/server";
import { z } from "zod";
import type { unscopedPrisma as prismaClient } from "@/server/db/tenant";
import type { ToolIdentity } from "@/server/ai/tools";
import type { redis as redisClient } from "@/server/integrations/redis";
import { allowedVoiceTools } from "@/lib/validators/voice";
import { callOutcomeFields, resolveCallDurationSeconds } from "@/server/voice/call-outcome";
import { upsertOwnCall } from "@/server/voice/call-rows";

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
        startedAt: z.string().nullish(),
        endedAt: z.string().nullish(),
        assistantOverrides: z.record(z.string(), z.unknown()).nullish(),
        customer: z.object({ number: z.string().optional() }).optional(),
        // Live Call Control URL. Unauthenticated unless the assistant enables
        // monitorPlan.controlAuthenticationEnabled, so it is treated as a secret.
        monitor: z.object({ controlUrl: z.string().nullish() }).nullish(),
      })
      .optional(),
    // The assistant as Vapi sent it in this signed message, when it does.
    assistant: z
      .object({
        firstMessage: z.string().nullish(),
        firstMessageMode: z.string().nullish(),
        firstMessageInterruptionsEnabled: z.boolean().nullish(),
      })
      .nullish(),
    toolCallList: z.array(toolCallSchema).max(MAX_TOOL_CALLS_PER_REQUEST).optional(),
    status: z.string().optional(),
    endedReason: z.string().optional(),
    durationSeconds: z.number().optional(),
    startedAt: z.string().nullish(),
    endedAt: z.string().nullish(),
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
 * pass this check until the first of them is billed. A read-only workspace
 * (past due beyond the grace period) may not use anything, as in assertWithinLimit.
 */
async function voiceQuotaExceeded(orgId: string, currentVapiCallId?: string): Promise<boolean> {
  const { getEntitlements } = await import("@/server/services/billing/entitlements");
  const { getVoiceUsageState, minutesCountedForLimits } =
    await import("@/server/services/billing/voice-usage");
  const [usage, ent] = await Promise.all([
    getVoiceUsageState(orgId, { excludeVapiCallId: currentVapiCallId }),
    getEntitlements(orgId),
  ]);
  return ent.readOnly || minutesCountedForLimits(usage) >= ent.voiceMinutesMonth;
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
): Promise<boolean> {
  if (!controlUrl || !isVapiControlUrl(controlUrl)) {
    console.warn(
      JSON.stringify({
        event: "voice_quota_end_call_skipped",
        reason: controlUrl ? "invalid_control_url" : "missing_control_url",
        ...ids,
      }),
    );
    return false;
  }
  // One retry: a refused call left running is the case limits exist to prevent.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(controlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "end-call" }),
        redirect: "error",
        signal: AbortSignal.timeout(END_CALL_TIMEOUT_MS),
      });
      if (res.ok) return true;
      console.warn(
        JSON.stringify({
          event: "voice_quota_end_call_failed",
          status: res.status,
          attempt,
          ...ids,
        }),
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "voice_quota_end_call_failed",
          name: err instanceof Error ? err.name : "unknown",
          attempt,
          ...ids,
        }),
      );
    }
  }
  return false;
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
      const { error, details } = parsed as { error?: unknown; details?: unknown };
      if (typeof error !== "string") return result;
      // Which fields were invalid (paths only, never messages or input values),
      // so the assistant can ask the caller again instead of guessing.
      const fields =
        error === "invalid_input" && Array.isArray(details)
          ? details
              .map((d) => (Array.isArray(d?.path) ? d.path.join(".") : null))
              .filter((f): f is string => typeof f === "string" && f.length > 0)
          : [];
      return JSON.stringify(fields.length > 0 ? { error, fields } : { error });
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
  if (!assistant) {
    // A soft-deleted organization's number, or a stale one, must not keep talking to callers.
    if (message.type === "status-update" && message.status === "in-progress" && message.call) {
      await endCallViaControlUrl(message.call.monitor?.controlUrl, {
        orgId: "unknown",
        vapiCallId: message.call.id,
      });
    }
    return NextResponse.json({ error: "unknown assistant" }, { status: 404 });
  }
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

      // A refused call that couldn't be hung up: no tools, and this reply can end it. First,
      // so a later check can't undo a refusal.
      {
        const { callRefusal } = await import("@/server/voice/call-admission");
        const refusal = message.call ? await callRefusal(orgId, message.call.id) : null;
        if (refusal) {
          const content = QUOTA_EXCEEDED_GOODBYE[assistant.language] ?? QUOTA_EXCEEDED_GOODBYE.EN;
          const results = (message.toolCallList ?? []).map((tc) =>
            refusal === "unknown"
              ? { toolCallId: tc.id, result: JSON.stringify({ error: "limits_unavailable" }) }
              : {
                  toolCallId: tc.id,
                  name: tc.name,
                  error: "call_refused",
                  message: { type: "request-failed", content, endCallAfterSpokenEnabled: true },
                },
          );
          return NextResponse.json({ results });
        }
      }

      // No tool of any kind on a call whose notice isn't confirmed. Checked here too, because
      // the status update can be missed and a hang-up can fail, and this reply is one Vapi acts
      // on: it speaks the line and ends the call. A missed start is recovered by checking now.
      {
        const { callDisclosureState, verifyCallDisclosure } =
          await import("@/server/voice/disclosure-gate");
        const vapiCallId = message.call?.id;
        const state = vapiCallId ? await callDisclosureState(orgId, vapiCallId) : "unverified";
        // A Redis blip isn't a failed check: refuse the tools, and leave a good call running.
        if (state === "unknown" && vapiCallId) {
          const results = (message.toolCallList ?? []).map((tc) => ({
            toolCallId: tc.id,
            result: JSON.stringify({ error: "limits_unavailable" }),
          }));
          return NextResponse.json({ results });
        }
        const confirmed =
          state === "verified" ||
          (state === "unverified" &&
            Boolean(vapiCallId) &&
            (await verifyCallDisclosure({
              orgId,
              vapiCallId: vapiCallId as string,
              language: assistant.language,
              vapiAssistantId: message.call?.assistantId as string,
              reported: message.assistant,
              overrides: message.call?.assistantOverrides,
            })) === "ok");
        if (!confirmed) {
          console.warn(JSON.stringify({ event: "voice_tools_refused", orgId, vapiCallId, state }));
          const content = QUOTA_EXCEEDED_GOODBYE[assistant.language] ?? QUOTA_EXCEEDED_GOODBYE.EN;
          const results = (message.toolCallList ?? []).map((tc) => ({
            toolCallId: tc.id,
            name: tc.name,
            error: "disclosure_not_verified",
            message: { type: "request-failed", content, endCallAfterSpokenEnabled: true },
          }));
          return NextResponse.json({ results });
        }
      }

      // Over quota: run no tool, say goodbye and end the call. Vapi acts on this
      // reply and ends the call once the line is spoken (endCallAfterSpokenEnabled).
      // Live Call Control is not used here: it would hang up before the goodbye.
      // Fails closed: when limits can't be checked, nothing runs, and writes can't slip through.
      let overQuota: boolean;
      try {
        overQuota = await voiceQuotaExceeded(orgId, message.call?.id);
      } catch {
        console.error(JSON.stringify({ event: "voice_limits_unavailable", orgId }));
        const results = (message.toolCallList ?? []).map((tc) => ({
          toolCallId: tc.id,
          result: JSON.stringify({ error: "limits_unavailable" }),
        }));
        return NextResponse.json({ results });
      }
      if (overQuota) {
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
      const enabled = new Set(allowedVoiceTools(assistant.enabledTools));

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
                tool: tc.name,
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
      const { admitCall, callRefusal, endCallSlot, markCallRefused } =
        await import("@/server/voice/call-admission");
      if (message.status === "ended" && message.call) {
        await endCallSlot(orgId, message.call.id);
      }
      if (message.status === "in-progress" && message.call) {
        const ids = { orgId, vapiCallId: message.call.id };
        // Replaying the start of a refused call changes nothing about that refusal.
        const refused = await callRefusal(orgId, message.call.id);
        if (refused && refused !== "unknown") {
          return NextResponse.json({ ok: true, duplicate: true });
        }
        // A signed start never expires. Replayed after the call, it must not take a slot.
        const known = await unscopedPrisma.voiceCall
          .findFirst({
            where: { organizationId: orgId, vapiCallId: message.call.id },
            select: { endedAt: true },
          })
          .catch(() => null);
        // Ended, or a retry for a call already recorded as running: nothing to do.
        if (known) return NextResponse.json({ ok: true, duplicate: true });

        // After the retry checks, so a retry can't end a call already admitted, and before
        // the limits: a call without its notice mustn't continue for any reason. The refusal
        // is recorded, so reconciliation doesn't later re-create the call.
        // A retry of a call that already passed isn't checked again: a Vapi blip now mustn't
        // end a call whose notice was confirmed.
        const { callDisclosureState, verifyCallDisclosure } =
          await import("@/server/voice/disclosure-gate");
        const disclosure =
          (await callDisclosureState(orgId, message.call.id)) === "verified"
            ? "ok"
            : await verifyCallDisclosure({
                orgId,
                vapiCallId: message.call.id,
                language: assistant.language,
                vapiAssistantId: message.call.assistantId as string,
                reported: message.assistant,
                overrides: message.call.assistantOverrides,
              });
        if (disclosure !== "ok") {
          console.warn(JSON.stringify({ event: "voice_call_refused", reason: disclosure, ...ids }));
          await markCallRefused(orgId, message.call.id, "notice");
          await endCallViaControlUrl(message.call.monitor?.controlUrl, ids);
          return NextResponse.json({ ok: true });
        }

        const admission = assistant.isActive
          ? await admitCall(orgId, message.call.id)
          : ({ admitted: false, reason: "assistant_inactive" } as const);
        if (!admission.admitted) {
          // No call row, and end the call through Live Call Control
          // (Vapi does not act on a reply to status-update).
          console.warn(
            JSON.stringify({ event: "voice_call_refused", reason: admission.reason, ...ids }),
          );
          // Marked before hanging up, so nothing can slip through while that's in progress.
          await markCallRefused(orgId, message.call.id, "ended");
          const hungUp = await endCallViaControlUrl(message.call.monitor?.controlUrl, ids);
          if (!hungUp) await markCallRefused(orgId, message.call.id, "running");
          return NextResponse.json({ ok: true });
        }
        // Another organization's call id: nothing is recorded (logged in upsertOwnCall).
        await upsertOwnCall(unscopedPrisma, orgId, {
          vapiCallId: message.call.id,
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
      const { callRefusal, endCallSlot, markCallRefused } =
        await import("@/server/voice/call-admission");
      await endCallSlot(orgId, message.call.id);
      // Syveka ended this call itself, or its notice wasn't confirmed: it isn't the customer's
      // usage. One refused by limits that couldn't be hung up really ran, so it's billed below.
      const refusal = await callRefusal(orgId, message.call.id);
      if (refusal === "ended" || refusal === "notice") {
        return NextResponse.json({ ok: true, refused: true });
      }
      // A call whose notice was never confirmed: keep nothing, charge nothing, and start no
      // pipeline, so its transcript doesn't reach the CRM or an AI provider. What happens to
      // the copy Vapi holds is a legal decision. If that can't be read, retry: the call may
      // have been fine, and its record shouldn't be lost to a Redis outage.
      {
        const { callDisclosureState, verifyCallDisclosure } =
          await import("@/server/voice/disclosure-gate");
        const state = await callDisclosureState(orgId, message.call.id);
        if (state === "unknown") {
          return NextResponse.json({ error: "try again" }, { status: 503 });
        }
        // A missed start isn't a failed check. A row is only created after the check passed,
        // and otherwise the live config can still confirm it now. Being unable to ask Vapi
        // isn't an answer, so the report is retried rather than dropped for good.
        const hasRow =
          state === "unverified" &&
          (await unscopedPrisma.voiceCall.findFirst({
            where: { organizationId: orgId, vapiCallId: message.call.id },
            select: { id: true },
          })) !== null;
        const late =
          state === "unverified" && !hasRow
            ? await verifyCallDisclosure({
                orgId,
                vapiCallId: message.call.id,
                language: assistant.language,
                vapiAssistantId: message.call.assistantId as string,
                reported: message.assistant,
                overrides: message.call.assistantOverrides,
              })
            : "ok";
        if (late === "unverifiable") {
          return NextResponse.json({ error: "try again" }, { status: 503 });
        }
        if (late !== "ok") {
          console.warn(
            JSON.stringify({
              event: "voice_report_without_notice",
              orgId,
              vapiCallId: message.call.id,
            }),
          );
          // Recorded, so reconciliation doesn't re-create it from Vapi's list.
          await markCallRefused(orgId, message.call.id, "notice");
          return NextResponse.json({ ok: true, refused: true });
        }
      }
      // Vapi documents these times on the report and on its call. Null means nothing
      // trustworthy said how long the call was: it stays unsettled, never "one minute".
      const startedAtText = message.startedAt ?? message.call.startedAt;
      const endedAtText = message.endedAt ?? message.call.endedAt;
      const durationSeconds = resolveCallDurationSeconds({
        startedAt: startedAtText,
        endedAt: endedAtText,
        durationSeconds: message.durationSeconds,
      });
      const endedMs = endedAtText ? Date.parse(endedAtText) : Number.NaN;
      const endedAt = Number.isNaN(endedMs) ? new Date() : new Date(endedMs);
      const startedMs = startedAtText ? Date.parse(startedAtText) : Number.NaN;
      const startedAt = !Number.isNaN(startedMs)
        ? new Date(startedMs)
        : new Date(endedAt.getTime() - (durationSeconds ?? 0) * 1000);
      // The same call details whether or not the in-progress status update was received:
      // post-call bills from durationSeconds and summarizes the transcript.
      const callResult = callOutcomeFields({
        endedReason: message.endedReason,
        cost: message.cost,
        durationSeconds,
        endedAt,
        messages: message.artifact?.messages,
        recordingUrl: message.artifact?.recordingUrl,
      });

      // A validly-signed report never expires, so a replay must not rewrite the
      // details of a call that has already ended (endedAt, transcript, cost...).
      const existing = await unscopedPrisma.voiceCall.findFirst({
        where: { organizationId: orgId, vapiCallId: message.call.id },
        select: { endedAt: true, durationSeconds: true, postCallProcessedAt: true },
      });
      if (existing?.postCallProcessedAt) {
        // Fully processed already: nothing to persist and nothing to re-enqueue.
        return NextResponse.json({ ok: true, duplicate: true });
      }
      // Ended but not yet processed (e.g. the first delivery's enqueue failed): keep the
      // recorded details and fall through so a legitimate retry can still enqueue.
      // The exception: a retry that finally knows the length of a call that had none.
      const learnsDuration =
        existing?.endedAt && existing.durationSeconds === null && durationSeconds !== null;
      if (!existing?.endedAt || learnsDuration) {
        const written = await upsertOwnCall(unscopedPrisma, orgId, {
          vapiCallId: message.call.id,
          create: {
            organizationId: orgId,
            assistantId: assistant.id,
            vapiCallId: message.call.id,
            callerNumber: message.call.customer?.number,
            startedAt,
            ...callResult,
          },
          update: callResult,
        });
        // Not this organization's call: no post-call work. A retry cannot change that.
        if (written === "foreign") {
          return NextResponse.json({ error: "call_conflict" }, { status: 409 });
        }
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
