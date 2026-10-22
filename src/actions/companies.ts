"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { actionWriteLimitError } from "@/server/security/rate-limit";
import {
  addCompanyNote,
  archiveCompany,
  createCompany,
  deleteCompany,
  restoreCompany,
  updateCompany,
} from "@/server/services/companies";
import { companySchema, noteSchema } from "@/lib/validators/crm";
import type { CrmActionState } from "./contacts";

export async function createCompanyAction(
  _prev: CrmActionState,
  formData: FormData,
): Promise<CrmActionState> {
  const ctx = await requirePermission("crm:write");
  const limited = await actionWriteLimitError("crm", ctx);
  if (limited) return { error: limited };
  const parsed = companySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createCompany(ctx, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath("/crm/companies");
  return { message: "created" };
}

export async function updateCompanyAction(
  companyId: string,
  _prev: CrmActionState,
  formData: FormData,
): Promise<CrmActionState> {
  const ctx = await requirePermission("crm:write");
  const limited = await actionWriteLimitError("crm", ctx);
  if (limited) return { error: limited };
  const parsed = companySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await updateCompany(ctx, companyId, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/companies/${companyId}`);
  revalidatePath("/crm/companies");
  return { message: "updated" };
}

export async function archiveCompanyAction(companyId: string): Promise<void> {
  const ctx = await requirePermission("crm:write");
  if (await actionWriteLimitError("crm", ctx)) return;
  await archiveCompany(ctx, companyId);
  revalidatePath(`/crm/companies/${companyId}`);
  revalidatePath("/crm/companies");
}

export async function restoreCompanyAction(companyId: string): Promise<void> {
  const ctx = await requirePermission("crm:write");
  if (await actionWriteLimitError("crm", ctx)) return;
  await restoreCompany(ctx, companyId);
  revalidatePath(`/crm/companies/${companyId}`);
  revalidatePath("/crm/companies");
}

export async function deleteCompanyAction(companyId: string): Promise<void> {
  const ctx = await requirePermission("crm:delete");
  if (await actionWriteLimitError("crm", ctx)) return;
  await deleteCompany(ctx, companyId);
  revalidatePath("/crm/companies");
}

export async function addCompanyNoteAction(
  companyId: string,
  _prev: CrmActionState,
  formData: FormData,
): Promise<CrmActionState> {
  const ctx = await requirePermission("crm:write");
  const limited = await actionWriteLimitError("crm", ctx);
  if (limited) return { error: limited };
  const parsed = noteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await addCompanyNote(ctx, companyId, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/companies/${companyId}`);
  return { message: "noteAdded" };
}
