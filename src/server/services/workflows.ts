import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { assertWithinLimit } from "./billing/entitlements";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { WorkflowInput } from "@/lib/validators/workflows";

export async function listWorkflows(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.workflow.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      runs: { orderBy: { startedAt: "desc" }, take: 1, select: { status: true, startedAt: true } },
      _count: { select: { runs: true } },
    },
  });
}

export async function upsertWorkflow(
  ctx: TenantContext,
  input: WorkflowInput,
  workflowId?: string,
) {
  const db = tenantDb(ctx.orgId);

  if (workflowId) {
    const before = await db.workflow.findFirstOrThrow({ where: { id: workflowId } });
    const workflow = await db.workflow.update({
      where: { id: workflowId },
      data: {
        name: input.name,
        description: input.description,
        trigger: input.trigger,
        steps: input.steps,
        version: { increment: 1 },
      },
    });
    await audit(ctx, {
      action: "workflow.update",
      resourceType: "workflow",
      resourceId: workflowId,
      before: { version: before.version },
      after: { version: workflow.version },
    });
    return workflow;
  }

  const workflow = await db.workflow.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      steps: input.steps,
      createdById: ctx.userId,
    },
  });
  await audit(ctx, {
    action: "workflow.create",
    resourceType: "workflow",
    resourceId: workflow.id,
    after: { name: input.name },
  });
  return workflow;
}

export async function setWorkflowActive(
  ctx: TenantContext,
  workflowId: string,
  isActive: boolean,
): Promise<void> {
  const db = tenantDb(ctx.orgId);
  if (isActive) {
    const active = await db.workflow.count({ where: { isActive: true } });
    await assertWithinLimit(ctx.orgId, { kind: "workflows", active });
  }
  await db.workflow.update({ where: { id: workflowId }, data: { isActive } });
  await audit(ctx, {
    action: isActive ? "workflow.activate" : "workflow.deactivate",
    resourceType: "workflow",
    resourceId: workflowId,
  });
}
