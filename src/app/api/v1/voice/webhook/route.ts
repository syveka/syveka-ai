import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client/client";
import type { unscopedPrisma as prismaClient } from "@/server/db/tenant";
import type { ToolIdentity } from "@/server/ai/tools";
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
        // Live Call Control URL. Unauthenticated unless the assistant enables
        // monitorPlan.controlAuthenticationEnabled, so it is treated as a secret.
        monitor: z.object({ controlUrl: z.string().nullish() }).nullish(),
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

      // Over quota: run no tool, say goodbye and end the call. Both the
      // request-failed message (endCallAfterSpokenEnabled) and Live Call
      // Control are used so the call ends even if one path is unavailable.
      if (await voiceQuotaExceeded(orgId)) {
        const content = QUOTA_EXCEEDED_GOODBYE[assistant.language] ?? QUOTA_EXCEEDED_GOODBYE.EN;
        const results = (message.toolCallList ?? []).map((tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          error: "quota_exceeded",
          message: { type: "request-failed", content, endCallAfterSpokenEnabled: true },
        }));
        if (message.call) {
          await endCallViaControlUrl(message.call.monitor?.controlUrl, {
            orgId,
            vapiCallId: message.call.id,
          });
        }
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
      const results = await Promise.all(
        (message.toolCallList ?? []).map(async (tc) => {
          if (!enabled.has(tc.name)) {
            return { toolCallId: tc.id, result: JSON.stringify({ error: "tool_not_enabled" }) };
          }
          const claimKey = `vapi:tool:${orgId}:${tc.id}`;
          const claimed = await redis.set(claimKey, "1", { nx: true, ex: 60 * 60 * 24 });
          if (claimed === null) {
            return { toolCallId: tc.id, result: JSON.stringify({ error: "duplicate_tool_call" }) };
          }
          try {
            return {
              toolCallId: tc.id,
              result: await executeTool(identity, tc.name, tc.arguments ?? {}),
            };
          } catch (err) {
            await redis.del(claimKey);
            throw err;
          }
        }),
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

      // Replay/idempotency guard for the post-call side effect only — the voiceCall
      // upsert above is already safe to repeat. A validly-signed end-of-call-report
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
