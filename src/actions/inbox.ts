"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { AuthError } from "@/server/auth/session";
import {
  approveMessage,
  assignThread,
  createContactFromThread,
  createDraftMessage,
  editDraftMessage,
  linkThreadToContact,
  markThreadUnread,
  searchContactsForLink,
  sendMessage,
  updateThreadStatus,
  InboxError,
} from "@/server/services/inbox";
import { generateEmailDraft } from "@/server/services/inbox-ai";
import { EntitlementError } from "@/server/services/billing/entitlements";
import {
  assignThreadSchema,
  createContactFromThreadSchema,
  createDraftMessageSchema,
  editDraftMessageSchema,
  linkThreadToContactSchema,
  searchContactsForLinkSchema,
  updateThreadStatusSchema,
} from "@/lib/validators/inbox";

export type InboxActionState = { error?: string; message?: string };

export type ContactSearchState = {
  results: { id: string; name: string; email: string | null }[];
  error?: string;
};

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

export async function generateDraftAction(
  threadId: string,
  _prev: InboxActionState,
  _formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  try {
    await generateEmailDraft(ctx, threadId);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${threadId}`);
  return { message: "drafted" };
}

export async function editDraftMessageAction(
  messageId: string,
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  const parsed = editDraftMessageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  let threadId: string;
  try {
    const updated = await editDraftMessage(ctx, messageId, parsed.data.body);
    threadId = updated.threadId;
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${threadId}`);
  return { message: "edited" };
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

/** Plain (void-returning) form action — used directly as a `<form action>` with no useActionState. */
export async function markThreadUnreadAction(threadId: string): Promise<void> {
  const ctx = await requirePermission("inbox:write");
  await markThreadUnread(ctx, threadId);
  revalidatePath(`/inbox/${threadId}`);
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

/** Requires both permissions since this action reaches across domains: it
 * both reads/mutates the thread (inbox:write) and creates a CRM contact
 * (crm:write). A user needs both, matching what they'd need to do each step
 * manually. */
export async function createContactFromThreadAction(
  threadId: string,
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  if (!can(ctx.role, "crm:write")) {
    throw new AuthError("Missing permission: crm:write", 403);
  }
  const parsed = createContactFromThreadSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createContactFromThread(ctx, threadId, parsed.data);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    if (e instanceof EntitlementError) return { error: "quota" };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${threadId}`);
  revalidatePath("/inbox");
  revalidatePath("/crm/contacts");
  return { message: "contact_created" };
}

/** Read-only search — requires inbox:write (this is part of the thread
 * detail operator surface) and crm:read (it queries CRM contacts). */
export async function searchContactsForLinkAction(
  _prev: ContactSearchState,
  formData: FormData,
): Promise<ContactSearchState> {
  const ctx = await requirePermission("inbox:write");
  if (!can(ctx.role, "crm:read")) {
    throw new AuthError("Missing permission: crm:read", 403);
  }
  const parsed = searchContactsForLinkSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { results: [] };

  const results = await searchContactsForLink(ctx, parsed.data.query);
  return { results };
}

export async function linkThreadToContactAction(
  threadId: string,
  _prev: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  const ctx = await requirePermission("inbox:write");
  if (!can(ctx.role, "crm:read")) {
    throw new AuthError("Missing permission: crm:read", 403);
  }
  const parsed = linkThreadToContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await linkThreadToContact(ctx, threadId, parsed.data.contactId);
  } catch (e) {
    if (e instanceof InboxError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath(`/inbox/${threadId}`);
  revalidatePath("/inbox");
  return { message: "contact_linked" };
}
