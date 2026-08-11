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

export async function approveMessageAction(messageId: string): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:approve");
  try {
    await approveMessage(ctx, messageId);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/inbox");
  return { message: "approved" };
}

export async function sendMessageAction(messageId: string): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  try {
    await sendMessage(ctx, messageId);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/inbox");
  return { message: "sent" };
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
