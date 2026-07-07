"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { createPrompt, deletePrompt, renderPrompt } from "@/server/services/prompts";
import { promptSchema } from "@/lib/validators/prompts";

export type PromptActionState = { error?: string; message?: string };

export async function createPromptAction(
  _prev: PromptActionState,
  formData: FormData,
): Promise<PromptActionState> {
  const ctx = await requirePermission("prompts:write");
  const parsed = promptSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };
  await createPrompt(ctx, parsed.data);
  revalidatePath("/prompts");
  return { message: "created" };
}

export async function deletePromptAction(promptId: string): Promise<void> {
  const ctx = await requirePermission("prompts:write");
  await deletePrompt(ctx, promptId);
  revalidatePath("/prompts");
}

export async function renderPromptAction(
  promptId: string,
  values: Record<string, string>,
): Promise<{ rendered: string }> {
  const ctx = await requirePermission("prompts:read");
  return { rendered: await renderPrompt(ctx, promptId, values) };
}
