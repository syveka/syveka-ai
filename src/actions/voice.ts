"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import { upsertAssistant, activateAssistant } from "@/server/services/voice";
import { voiceAssistantSchema } from "@/lib/validators/voice";

export type VoiceActionState = { error?: string; message?: string };

export async function saveAssistantAction(
  assistantId: string | undefined,
  _prev: VoiceActionState,
  formData: FormData,
): Promise<VoiceActionState> {
  const ctx = await requirePermission("voice:configure");

  const raw = Object.fromEntries(formData);
  const parsed = voiceAssistantSchema.safeParse({
    ...raw,
    enabledTools: formData.getAll("enabledTools"),
    useKnowledgeBase: raw.useKnowledgeBase === "true",
  });
  if (!parsed.success) return { error: "invalid_input" };

  let id = assistantId;
  try {
    const assistant = await upsertAssistant(ctx, parsed.data, assistantId);
    id = assistant.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "failed" };
  }

  revalidatePath("/voice");
  if (!assistantId) redirect(`/voice/${id}`);
  return { message: "saved" };
}

export async function activateAssistantAction(assistantId: string): Promise<void> {
  const ctx = await requirePermission("voice:configure");
  await activateAssistant(ctx, assistantId);
  revalidatePath(`/voice/${assistantId}`);
  revalidatePath("/voice");
}
