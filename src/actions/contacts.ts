"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import {
  createContact, updateContact, deleteContact,
} from "@/server/services/contacts";
import { contactSchema } from "@/lib/validators/crm";
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

  await updateContact(ctx, contactId, parsed.data);
  revalidatePath(`/crm/contacts/${contactId}`);
  revalidatePath("/crm/contacts");
  return { message: "updated" };
}

export async function deleteContactAction(contactId: string): Promise<void> {
  const ctx = await requirePermission("crm:delete");
  await deleteContact(ctx, contactId);
  revalidatePath("/crm/contacts");
}
