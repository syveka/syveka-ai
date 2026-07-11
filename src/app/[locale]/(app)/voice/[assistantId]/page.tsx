export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb } from "@/server/db/tenant";
import { AssistantForm } from "@/components/voice/assistant-form";
import type { VoiceAssistantInput } from "@/lib/validators/voice";

export default async function AssistantPage({
  params,
}: {
  params: Promise<{ assistantId: string }>;
}) {
  const { assistantId } = await params;
  const ctx = await requirePermission("voice:configure");

  if (assistantId === "new") {
    return <AssistantForm />;
  }

  const assistant = await tenantDb(ctx.orgId).voiceAssistant.findFirst({
    where: { id: assistantId },
  });
  if (!assistant) notFound();

  const initial: VoiceAssistantInput & {
    id: string;
    isActive: boolean;
    phoneNumber: string | null;
  } = {
    id: assistant.id,
    isActive: assistant.isActive,
    phoneNumber: assistant.phoneNumber,
    name: assistant.name,
    language: assistant.language,
    voiceProvider: assistant.voiceProvider as "azure" | "elevenlabs",
    voiceId: assistant.voiceId ?? "",
    firstMessage: assistant.firstMessage,
    systemPrompt: assistant.systemPrompt,
    enabledTools: (assistant.enabledTools as VoiceAssistantInput["enabledTools"]) ?? [],
    useKnowledgeBase: assistant.useKnowledgeBase,
    transferNumber: assistant.transferNumber ?? "",
  };

  return <AssistantForm initial={initial} />;
}
