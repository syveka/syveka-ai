"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { createDeal, moveDeal } from "@/server/services/deals";
import { dealSchema, moveDealSchema } from "@/lib/validators/crm";

export type DealActionState = { error?: string; message?: string };

export async function createDealAction(
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = dealSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  await createDeal(ctx, parsed.data);
  revalidatePath("/crm/deals");
  return { message: "created" };
}

export async function moveDealAction(input: { dealId: string; stageId: string }): Promise<void> {
  const ctx = await requirePermission("crm:write");
  const parsed = moveDealSchema.parse(input);
  await moveDeal(ctx, parsed.dealId, parsed.stageId);
  revalidatePath("/crm/deals");
}
