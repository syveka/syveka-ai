"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import {
  addDealNote,
  addDealTask,
  createDeal,
  createStage,
  DealError,
  deleteDeal,
  deleteStage,
  generateDealInsights,
  moveDeal,
  toggleDealTask,
  updateDeal,
  updateStage,
} from "@/server/services/deals";
import {
  dealSchema,
  dealTaskSchema,
  moveDealSchema,
  noteSchema,
  pipelineStageSchema,
} from "@/lib/validators/crm";
import { EntitlementError } from "@/server/services/billing/entitlements";

export type DealActionState = { error?: string; message?: string };

function toErrorState(e: unknown): DealActionState {
  if (e instanceof EntitlementError) return { error: "quota" };
  if (e instanceof DealError) return { error: e.code };
  return { error: "failed" };
}

export async function createDealAction(
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = dealSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createDeal(ctx, parsed.data);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath("/crm/deals");
  return { message: "created" };
}

export async function updateDealAction(
  dealId: string,
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = dealSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await updateDeal(ctx, dealId, parsed.data);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath(`/crm/deals/${dealId}`);
  revalidatePath("/crm/deals");
  return { message: "updated" };
}

export async function moveDealAction(input: {
  dealId: string;
  stageId: string;
  position: number;
}): Promise<void> {
  const ctx = await requirePermission("crm:write");
  const parsed = moveDealSchema.parse(input);
  await moveDeal(ctx, parsed);
  revalidatePath("/crm/deals");
}

export async function deleteDealAction(dealId: string): Promise<void> {
  const ctx = await requirePermission("crm:delete");
  await deleteDeal(ctx, dealId);
  revalidatePath("/crm/deals");
}

export async function addDealNoteAction(
  dealId: string,
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = noteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await addDealNote(ctx, dealId, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/deals/${dealId}`);
  return { message: "noteAdded" };
}

export async function addDealTaskAction(
  dealId: string,
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:write");
  const parsed = dealTaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await addDealTask(ctx, dealId, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/deals/${dealId}`);
  return { message: "taskAdded" };
}

export async function toggleDealTaskAction(
  dealId: string,
  taskId: string,
  completed: boolean,
): Promise<void> {
  const ctx = await requirePermission("crm:write");
  await toggleDealTask(ctx, dealId, taskId, completed);
  revalidatePath(`/crm/deals/${dealId}`);
}

export async function generateDealInsightsAction(
  dealId: string,
  _prev: DealActionState,
  _formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:write");
  try {
    await generateDealInsights(ctx, dealId);
  } catch {
    return { error: "failed" };
  }
  revalidatePath(`/crm/deals/${dealId}`);
  return { message: "insightsGenerated" };
}

export async function createStageAction(
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:manage-pipeline");
  const parsed = pipelineStageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await createStage(ctx, parsed.data);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath("/crm/deals");
  return { message: "stageCreated" };
}

export async function updateStageAction(
  stageId: string,
  _prev: DealActionState,
  formData: FormData,
): Promise<DealActionState> {
  const ctx = await requirePermission("crm:manage-pipeline");
  const parsed = pipelineStageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await updateStage(ctx, stageId, parsed.data);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath("/crm/deals");
  return { message: "stageUpdated" };
}

export async function deleteStageAction(stageId: string): Promise<DealActionState> {
  const ctx = await requirePermission("crm:manage-pipeline");
  try {
    await deleteStage(ctx, stageId);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath("/crm/deals");
  return { message: "stageDeleted" };
}
