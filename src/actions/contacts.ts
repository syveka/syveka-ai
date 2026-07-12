"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import {
  addContactNote,
  archiveContact,
  createContact,
  deleteContact,
  restoreContact,
  updateContact,
} from "@/server/services/contacts";
import { contactSchema, noteSchema } from "@/lib/validators/crm";
import { EntitlementError } from "@/server/services/billing/entitlements";

export type CrmActionState = { error?: string; message?: string };

export async function createContactAction(
  _prev: CrmActionState,
  formData: FormData,
): Promise<CrmActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = contactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createContact(ctx, parsed.data);
  } catch (e) {
    if (e instanceof EntitlementError) return { error: "quota" };
    return { error: "failed" };
  }
  revalidatePath("/crm/contacts");
  return { message: "created" };
}

export async function updateContactAction(
  contactId: string,
  _prev: CrmActionState,
  formData: FormData,
): Promise<CrmActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = contactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await updateContact(ctx, contactId, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/contacts/${contactId}`);
  revalidatePath("/crm/contacts");
  return { message: "updated" };
}

export async function archiveContactAction(contactId: string): Promise<void> {
  const ctx = await requirePermission("crm:write");
  await archiveContact(ctx, contactId);
  revalidatePath(`/crm/contacts/${contactId}`);
  revalidatePath("/crm/contacts");
}

export async function restoreContactAction(contactId: string): Promise<void> {
  const ctx = await requirePermission("crm:write");
  await restoreContact(ctx, contactId);
  revalidatePath(`/crm/contacts/${contactId}`);
  revalidatePath("/crm/contacts");
}

export async function deleteContactAction(contactId: string): Promise<void> {
  const ctx = await requirePermission("crm:delete");
  await deleteContact(ctx, contactId);
  revalidatePath("/crm/contacts");
}

export async function addContactNoteAction(
  contactId: string,
  _prev: CrmActionState,
  formData: FormData,
): Promise<CrmActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = noteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await addContactNote(ctx, contactId, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/contacts/${contactId}`);
  return { message: "noteAdded" };
}
