"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import {
  createBusinessDnaService,
  deactivateBusinessDnaService,
  reactivateBusinessDnaService,
  updateBusinessDnaService,
} from "@/server/services/business-dna-services";
import { businessDnaServiceSchema } from "@/lib/validators/business-dna";

export type BusinessDnaServiceActionState = { error?: string; message?: string };

/**
 * The form collects price as a decimal major-unit string ("10.50", the
 * customer-facing convention) under the field name `price` -- never
 * `priceCents` directly, since a user should never have to think in cents.
 * This is the one place that converts to the integer-cents the schema and
 * database actually store. An empty/whitespace-only value means "no numeric
 * price" (quote-only pricing via `priceNote`), not zero.
 */
function parseServiceFormData(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const { price, ...rest } = raw as Record<string, FormDataEntryValue>;
  const priceMajorUnits = typeof price === "string" ? price.trim() : "";

  const data: Record<string, unknown> = {
    ...rest,
    // isActive is a checkbox: present in FormData only when checked.
    isActive: formData.has("isActive"),
  };
  if (priceMajorUnits !== "") {
    // Deliberately NaN, not omitted, when unparseable: an empty value means
    // "no numeric price" (quote-only, via priceNote), but a garbled one
    // must fail validation rather than silently vanish -- z.coerce.number()
    // rejects NaN the same way it rejects any other non-numeric input.
    const parsed = Number(priceMajorUnits);
    data.priceCents = Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN;
  }

  return businessDnaServiceSchema.safeParse(data);
}

export async function createBusinessDnaServiceAction(
  _prev: BusinessDnaServiceActionState,
  formData: FormData,
): Promise<BusinessDnaServiceActionState> {
  const ctx = await requirePermission("business-dna:write");

  const parsed = parseServiceFormData(formData);
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createBusinessDnaService(ctx, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath("/settings/business-dna");
  return { message: "created" };
}

export async function updateBusinessDnaServiceAction(
  id: string,
  _prev: BusinessDnaServiceActionState,
  formData: FormData,
): Promise<BusinessDnaServiceActionState> {
  const ctx = await requirePermission("business-dna:write");

  const parsed = parseServiceFormData(formData);
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await updateBusinessDnaService(ctx, id, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath("/settings/business-dna");
  return { message: "saved" };
}

export async function deactivateBusinessDnaServiceAction(id: string): Promise<void> {
  const ctx = await requirePermission("business-dna:write");
  await deactivateBusinessDnaService(ctx, id);
  revalidatePath("/settings/business-dna");
}

export async function reactivateBusinessDnaServiceAction(id: string): Promise<void> {
  const ctx = await requirePermission("business-dna:write");
  await reactivateBusinessDnaService(ctx, id);
  revalidatePath("/settings/business-dna");
}
