"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { getBusinessDNA, upsertBusinessDNA } from "@/server/services/business-dna";
import { businessDnaSchema } from "@/lib/validators/business-dna";

export type BusinessDnaActionState = { error?: string; message?: string };

export async function getBusinessDnaAction() {
  const ctx = await requirePermission("business-dna:read");
  return getBusinessDNA(ctx);
}

export async function updateBusinessDnaAction(
  _prev: BusinessDnaActionState,
  formData: FormData,
): Promise<BusinessDnaActionState> {
  const ctx = await requirePermission("business-dna:write");

  const raw = Object.fromEntries(formData);
  let openingHours: unknown;
  if (raw.openingHours) {
    try {
      openingHours = JSON.parse(String(raw.openingHours));
    } catch {
      return { error: "invalid_input" };
    }
  }

  const parsed = businessDnaSchema.safeParse({
    ...raw,
    supportedLocales: formData.getAll("supportedLocales"),
    keyFacts: formData
      .getAll("keyFacts")
      .flatMap((v) => String(v).split("\n"))
      .map((v) => v.trim())
      .filter(Boolean),
    openingHours,
  });
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await upsertBusinessDNA(ctx, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath("/settings/business-dna");
  return { message: "saved" };
}
