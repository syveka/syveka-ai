import "server-only";

import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import {
  upsertVapiAssistant,
  buyPhoneNumber,
  type VapiAssistantConfig,
} from "@/server/integrations/vapi";
import { TOOL_REGISTRY, zodToJsonSchema } from "@/server/ai/tools";
import { getEntitlements } from "./billing/entitlements";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { VoiceAssistantInput } from "@/lib/validators/voice";
import { env } from "@/env";

/** Zod tool schemas → OpenAI-function JSON for Vapi (§16.2). */
function vapiToolsFor(enabledNames: string[]) {
  return TOOL_REGISTRY.filter((t) => enabledNames.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: zodToJsonSchema(t.schema),
  }));
}

export async function listAssistants(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.voiceAssistant.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { calls: true } } },
  });
}

export async function upsertAssistant(
  ctx: TenantContext,
  input: VoiceAssistantInput,
  assistantId?: string,
) {
  const db = tenantDb(ctx.orgId);

  if (!assistantId) {
    const ent = await getEntitlements(ctx.orgId);
    const count = await db.voiceAssistant.count();
    if (count >= ent.voiceAssistants) {
      throw new Error("Voice assistant limit reached for your plan");
    }
  }

  const data = {
    organizationId: ctx.orgId,
    name: input.name,
    language: input.language,
    voiceProvider: input.voiceProvider,
    voiceId: input.voiceId || null,
    firstMessage: input.firstMessage,
    systemPrompt: input.systemPrompt,
    enabledTools: input.enabledTools,
    useKnowledgeBase: input.useKnowledgeBase,
    transferNumber: input.transferNumber || null,
  };

  const assistant = assistantId
    ? await db.voiceAssistant.update({ where: { id: assistantId }, data })
    : await db.voiceAssistant.create({ data });

  // If already linked to Vapi, re-sync config on every save (§16.2)
  if (assistant.vapiAssistantId) {
    await syncToVapi(assistant.id, ctx.orgId);
  }

  await audit(ctx, {
    action: assistantId ? "voice_assistant.update" : "voice_assistant.create",
    resourceType: "voice_assistant",
    resourceId: assistant.id,
    after: { name: input.name, language: input.language },
  });
  return assistant;
}

/** Activate: upsert on Vapi + provision a Finnish number (§16.2). */
export async function activateAssistant(ctx: TenantContext, assistantId: string) {
  const db = tenantDb(ctx.orgId);
  const assistant = await db.voiceAssistant.findFirstOrThrow({ where: { id: assistantId } });

  const vapiId = await syncToVapi(assistantId, ctx.orgId);

  let phoneNumber = assistant.phoneNumber;
  if (!phoneNumber) {
    const number = await buyPhoneNumber(vapiId);
    phoneNumber = number.number;
  }

  const updated = await db.voiceAssistant.update({
    where: { id: assistantId },
    data: { isActive: true, phoneNumber, vapiAssistantId: vapiId },
  });

  await audit(ctx, {
    action: "voice_assistant.activate",
    resourceType: "voice_assistant",
    resourceId: assistantId,
    after: { phoneNumber },
  });
  return updated;
}

async function syncToVapi(assistantId: string, orgId: string): Promise<string> {
  const assistant = await unscopedPrisma.voiceAssistant.findFirstOrThrow({
    where: { id: assistantId, organizationId: orgId },
  });

  const enabledTools = (assistant.enabledTools as string[]) ?? [];
  const toolNames = assistant.useKnowledgeBase
    ? [...new Set(["searchKnowledgeBase", ...enabledTools])]
    : enabledTools;

  // Mandatory AI disclosure (§13.3, §16.5) is prepended server-side.
  const disclosure =
    assistant.language === "FI"
      ? "Aloita kertomalla, että olet tekoälyavustaja ja puhelu voidaan tallentaa."
      : "Start by disclosing that you are an AI assistant and the call may be recorded.";

  const config: VapiAssistantConfig = {
    name: assistant.name,
    firstMessage: assistant.firstMessage,
    systemPrompt: `${disclosure}\n\n${assistant.systemPrompt}${
      assistant.transferNumber
        ? `\n\nIf the caller asks for a human, transfer the call to ${assistant.transferNumber}.`
        : ""
    }`,
    language: assistant.language.toLowerCase() as "fi" | "en" | "ar",
    voiceProvider: assistant.voiceProvider,
    voiceId: assistant.voiceId,
    serverUrl: `${env.NEXT_PUBLIC_APP_URL}/api/v1/voice/webhook`,
    serverUrlSecret: env.VAPI_WEBHOOK_SECRET,
    tools: vapiToolsFor(toolNames),
    maxDurationSeconds: 15 * 60, // §16.5
  };

  const { id } = await upsertVapiAssistant(config, assistant.vapiAssistantId);
  if (id !== assistant.vapiAssistantId) {
    await unscopedPrisma.voiceAssistant.update({
      where: { id: assistantId },
      data: { vapiAssistantId: id },
    });
  }
  return id;
}

export async function listCalls(ctx: TenantContext, params?: { assistantId?: string }) {
  const db = tenantDb(ctx.orgId);
  return db.voiceCall.findMany({
    where: params?.assistantId ? { assistantId: params.assistantId } : {},
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { assistant: { select: { name: true } } },
  });
}
