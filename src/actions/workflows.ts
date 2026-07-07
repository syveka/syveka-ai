"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import {
  upsertWorkflow, setWorkflowActive,
} from "@/server/services/workflows";
import { workflowSchema } from "@/lib/validators/workflows";
import { EntitlementError } from "@/server/services/billing/entitlements";

export type WorkflowActionState = { error?: string; message?: string };

export async function saveWorkflowAction(
  workflowId: string | undefined,
  payload: unknown,
): Promise<WorkflowActionState> {
  const ctx = await requirePermission("workflows:manage");
  const parsed = workflowSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "invalid_input" };
  }

  const workflow = await upsertWorkflow(ctx, parsed.data, workflowId);
  revalidatePath("/workflows");
  if (!workflowId) redirect(`/workflows/${workflow.id}`);
  return { message: "saved" };
}

export async function toggleWorkflowAction(workflowId: string, isActive: boolean): Promise<WorkflowActionState> {
  const ctx = await requirePermission("workflows:manage");
  try {
    await setWorkflowActive(ctx, workflowId, isActive);
  } catch (e) {
    if (e instanceof EntitlementError) return { error: "quota" };
    throw e;
  }
  revalidatePath("/workflows");
  revalidatePath(`/workflows/${workflowId}`);
  return { message: "toggled" };
}

/** Test run (§17.2): creates a run row and enqueues it directly, bypassing isActive. */
export async function testWorkflowAction(workflowId: string): Promise<void> {
  const ctx = await requirePermission("workflows:manage");
  const { unscopedPrisma } = await import("@/server/db/tenant");
  const { enqueue } = await import("@/server/jobs/queue");

  const workflow = await unscopedPrisma.workflow.findFirstOrThrow({
    where: { id: workflowId, organizationId: ctx.orgId },
  });
  const run = await unscopedPrisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      organizationId: ctx.orgId,
      triggerData: { test: true, triggeredBy: ctx.userId },
      status: "RUNNING",
    },
  });
  await enqueue("run-workflow", {
    workflowId: workflow.id,
    orgId: ctx.orgId,
    triggerType: "manual",
    triggerData: { test: true, triggeredBy: ctx.userId },
    runId: run.id,
    resumeFromIndex: 0,
  });
  revalidatePath(`/workflows/${workflowId}`);
}
