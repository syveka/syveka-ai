import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { verifyVapiSignature } from "@/server/integrations/vapi";
import { unscopedPrisma } from "@/server/db/tenant";
import { executeTool, type ToolIdentity } from "@/server/ai/tools";
import { getMonthUsage, getEntitlements } from "@/server/services/billing/entitlements";
import { enqueue } from "@/server/jobs/queue";

export const runtime = "nodejs";
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

async function resolveAssistant(vapiAssistantId: string | undefined) {
  if (!vapiAssistantId) return null;
  return unscopedPrisma.voiceAssistant.findFirst({
    where: { vapiAssistantId },
    select: {
      id: true,
      organizationId: true,
      enabledTools: true,
      useKnowledgeBase: true,
      organization: {
        select: { members: { where: { role: "OWNER" }, select: { userId: true }, take: 1 } },
      },
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-vapi-signature") ?? request.headers.get("x-vapi-secret");
  if (!verifyVapiSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const parsed = messageSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { message } = parsed.data;

  const assistant = await resolveAssistant(message.call?.assistantId);
  if (!assistant) return NextResponse.json({ error: "unknown assistant" }, { status: 404 });
  const orgId = assistant.organizationId;
  const ownerUserId = assistant.organization.members[0]?.userId ?? "";

  switch (message.type) {
    // ── In-call tool execution (§16.3) ──
    case "tool-calls": {
      // Voice acts as a restricted MANAGER-level service identity limited to
      // its enabledTools (§15.4).
      const identity: ToolIdentity = {
        orgId,
        userId: ownerUserId,
        role: "MANAGER",
        actorType: "voice_ai",
      };
      const enabled = new Set([
        ...((assistant.enabledTools as string[]) ?? []),
        ...(assistant.useKnowledgeBase ? ["searchKnowledgeBase"] : []),
      ]);

      const results = await Promise.all(
        (message.toolCallList ?? []).map(async (tc) => ({
          toolCallId: tc.id,
          result: enabled.has(tc.name)
            ? await executeTool(identity, tc.name, tc.arguments ?? {})
            : JSON.stringify({ error: "tool_not_enabled" }),
        })),
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

      await unscopedPrisma.voiceCall.upsert({
        where: { vapiCallId: message.call.id },
        create: {
          organizationId: orgId,
          assistantId: assistant.id,
          vapiCallId: message.call.id,
          callerNumber: message.call.customer?.number,
          startedAt: new Date(Date.now() - durationSeconds * 1000),
          status: "COMPLETED",
        },
        update: {
          status: message.endedReason === "assistant-forwarded-call" ? "TRANSFERRED" : "COMPLETED",
          endedAt: new Date(),
          durationSeconds,
          costCents: Math.round((message.cost ?? 0) * 100),
          endedReason: message.endedReason,
          transcript: message.artifact?.messages as Prisma.InputJsonValue | undefined,
          recordingUrl: message.artifact?.recordingUrl,
        },
      });

      await enqueue("post-call", { vapiCallId: message.call.id, orgId });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ ok: true });
  }
}
