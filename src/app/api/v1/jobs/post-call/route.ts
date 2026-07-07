import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyJobRequest } from "@/server/jobs/verify";
import { unscopedPrisma } from "@/server/db/tenant";
import { anthropic } from "@/server/integrations/anthropic";
import { routeModel } from "@/server/ai/router";
import { recordUsage } from "@/server/services/billing/entitlements";
import { emitWorkflowEvent } from "@/server/services/workflow-events";

export const runtime = "nodejs";
export const maxDuration = 120;

const payloadSchema = z.object({
  vapiCallId: z.string(),
  orgId: z.string().uuid(),
});

const analysisSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  followUps: z.array(z.string()).max(5),
});

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { vapiCallId, orgId } = parsed.data;

  const call = await unscopedPrisma.voiceCall.findFirst({
    where: { vapiCallId, organizationId: orgId },
    include: { assistant: { select: { name: true, language: true } } },
  });
  if (!call) return NextResponse.json({ skipped: "call not found" });

  // 1. Usage metering — minutes rounded up (§14.2)
  const minutes = Math.max(1, Math.ceil((call.durationSeconds ?? 0) / 60));
  await recordUsage(orgId, "VOICE_MINUTES", minutes, { callId: call.id });

  // 2. Contact match/create from caller number (§16.4)
  let contactId = call.contactId;
  if (!contactId && call.callerNumber) {
    const normalized = call.callerNumber.replace(/\s/g, "");
    const existing = await unscopedPrisma.contact.findFirst({
      where: { organizationId: orgId, phone: normalized, deletedAt: null },
    });
    if (existing) {
      contactId = existing.id;
    } else if (call.status === "COMPLETED") {
      const created = await unscopedPrisma.contact.create({
        data: {
          organizationId: orgId,
          firstName: normalized, // placeholder until enriched
          phone: normalized,
          source: "voice-ai",
          status: "LEAD",
        },
      });
      contactId = created.id;
    }
    if (contactId) {
      await unscopedPrisma.voiceCall.update({ where: { id: call.id }, data: { contactId } });
    }
  }

  // 3. AI summary + sentiment (Haiku-class, §15.2)
  const transcriptText = JSON.stringify(call.transcript ?? []).slice(0, 30_000);
  if (transcriptText.length > 10) {
    try {
      const { model, maxTokens } = routeModel("summary");
      const res = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: `Analyze this phone call transcript. Respond with ONLY valid JSON: {"summary": "<3-5 sentence summary in ${
              call.assistant.language === "FI" ? "Finnish" : "English"
            }>", "sentiment": "positive"|"neutral"|"negative", "followUps": ["<action item>", ...max 5]}\n\nTranscript:\n${transcriptText}`,
          },
        ],
      });
      const text = res.content[0]?.type === "text" ? res.content[0].text : "{}";
      const json = analysisSchema.safeParse(JSON.parse(text.replace(/^```json?|```$/g, "").trim()));

      if (json.success) {
        await unscopedPrisma.voiceCall.update({
          where: { id: call.id },
          data: {
            summary: json.data.summary,
            sentiment: json.data.sentiment,
            actionsTaken: json.data.followUps,
          },
        });

        if (contactId) {
          await unscopedPrisma.activity.create({
            data: {
              organizationId: orgId,
              contactId,
              type: "VOICE_AI_CALL",
              subject: `${call.assistant.name}: ${json.data.sentiment} call (${minutes} min)`,
              body: json.data.summary,
              metadata: { voiceCallId: call.id, followUps: json.data.followUps },
            },
          });
        }
      }
    } catch {
      // summary is best-effort — the call record stands without it
    }
  }

  // 4. Notify org owner + workflow trigger (§16.4)
  const owner = await unscopedPrisma.organizationMember.findFirst({
    where: { organizationId: orgId, role: "OWNER" },
    select: { userId: true },
  });
  if (owner) {
    await unscopedPrisma.notification.create({
      data: {
        organizationId: orgId,
        userId: owner.userId,
        type: "call.completed",
        title: call.assistant.name,
        body: `${call.callerNumber ?? "Unknown"} · ${minutes} min`,
        href: `/voice/calls/${call.id}`,
      },
    });
  }

  await emitWorkflowEvent(orgId, "call.completed", {
    callId: call.id,
    contactId,
    durationSeconds: call.durationSeconds,
    sentiment: call.sentiment,
  });

  return NextResponse.json({ ok: true });
}
