"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import {
  approveMessage,
  assignThread,
  createDraftMessage,
  sendMessage,
  updateThreadStatus,
  InboxError,
} from "@/server/services/inbox";
import { generateEmailDraft } from "@/server/services/inbox-ai";
import {
  assignThreadSchema,
  createDraftMessageSchema,
  updateThreadStatusSchema,
} from "@/lib/validators/inbox";

export type InboxActionState = { error?: string; message?: string };

export async function createDraftMessageAction(
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  const parsed = createDraftMessageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createDraftMessage(ctx, parsed.data);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${parsed.data.threadId}`);
  return { message: "drafted" };
}

/** Plain (void-returning) form action — used directly as a `<form action>` with no useActionState. */
export async function generateDraftAction(threadId: string): Promise<void> {
  const ctx = await requirePermission("inbox:write");
  await generateEmailDraft(ctx, threadId);
  revalidatePath(`/inbox/${threadId}`);
}

/** Plain (void-returning) form action — used directly as a `<form action>` with no useActionState. */
export async function approveMessageAction(messageId: string): Promise<void> {
  const ctx = await requirePermission("inbox:approve");
  const updated = await approveMessage(ctx, messageId);
  revalidatePath(`/inbox/${updated.threadId}`);
  revalidatePath("/inbox");
}

/** Plain (void-returning) form action — used directly as a `<form action>` with no useActionState. */
export async function sendMessageAction(messageId: string): Promise<void> {
  const ctx = await requirePermission("inbox:write");
  const updated = await sendMessage(ctx, messageId);
  revalidatePath(`/inbox/${updated.threadId}`);
  revalidatePath("/inbox");
}

export async function updateThreadStatusAction(
  threadId: string,
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  const parsed = updateThreadStatusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await updateThreadStatus(ctx, threadId, parsed.data);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${threadId}`);
  revalidatePath("/inbox");
  return { message: "updated" };
}

export async function assignThreadAction(
  threadId: string,
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  const parsed = assignThreadSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await assignThread(ctx, threadId, parsed.data);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${threadId}`);
  revalidatePath("/inbox");
  return { message: "updated" };
}
