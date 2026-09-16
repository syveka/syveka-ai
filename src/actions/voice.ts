"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import {
  upsertAssistant,
  activateAssistant,
  attachPhoneNumber,
  DuplicatePhoneNumberError,
  AssistantNotSyncedError,
} from "@/server/services/voice";
import { voiceAssistantSchema, attachPhoneNumberSchema } from "@/lib/validators/voice";

export type VoiceActionState = {
  error?: string;
  message?: string;
  /** Vapi assistant synced successfully but no phone number could be
   * provisioned -- a controlled, retryable state, never a crash. */
  phoneNumberPending?: boolean;
};

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

export async function activateAssistantAction(
  assistantId: string,
  _prev: VoiceActionState,
): Promise<VoiceActionState> {
  const ctx = await requirePermission("voice:configure");

  let result: Awaited<ReturnType<typeof activateAssistant>>;
  try {
    result = await activateAssistant(ctx, assistantId);
  } catch {
    // Never surface a raw Error.message here -- activateAssistant() can
    // throw a raw Vapi provider error (see vapiFetch's error construction,
    // up to 500 chars of the provider's own response text), and unlike
    // attachPhoneNumberAction's equivalent fallback, assistant-form.tsx
    // renders this value verbatim in the UI. A generic, translated message
    // is the fix; the specific phoneNumberError case above is unaffected --
    // that path already returns a controlled, non-error state.
    return { error: "generic" };
  }

  revalidatePath(`/voice/${assistantId}`);
  revalidatePath("/voice");

  if (result.phoneNumberError) return { phoneNumberPending: true };
  return { message: "activated" };
}

export async function attachPhoneNumberAction(
  assistantId: string,
  _prev: VoiceActionState,
  formData: FormData,
): Promise<VoiceActionState> {
  const ctx = await requirePermission("voice:configure");

  const parsed = attachPhoneNumberSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await attachPhoneNumber(ctx, assistantId, parsed.data);
  } catch (e) {
    if (e instanceof DuplicatePhoneNumberError) return { error: "phone_number_in_use" };
    if (e instanceof AssistantNotSyncedError) return { error: "assistant_not_synced" };
    // Never surface a raw Error.message here -- for this action that could
    // include up to 500 chars of a raw Vapi/Twilio provider error response
    // (see vapiFetch's error construction), which must not reach the client
    // even if today's UI component doesn't happen to render it verbatim.
    return { error: "generic" };
  }

  revalidatePath(`/voice/${assistantId}`);
  revalidatePath("/voice");
  return { message: "phone_number_attached" };
}
