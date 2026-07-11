import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import { emitWorkflowEvent } from "./workflow-events";
import type { TenantContext } from "@/server/auth/session";
import type { DealInput } from "@/lib/validators/crm";

/** Kanban board data: default pipeline + stages + open deals (§18). */
export async function getBoard(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const pipeline = await db.pipeline.findFirst({
    where: { isDefault: true },
    include: {
      stages: {
        orderBy: { order: "asc" },
        include: {
          deals: {
            where: { deletedAt: null, closedAt: null, organizationId: ctx.orgId },
            orderBy: { updatedAt: "desc" },
            include: { contact: { select: { firstName: true, lastName: true } } },
          },
        },
      },
    },
  });
  return pipeline;
}

export async function createDeal(ctx: TenantContext, input: DealInput) {
  const db = tenantDb(ctx.orgId);
  const stage = await db.pipeline.findFirstOrThrow({
    where: { stages: { some: { id: input.stageId } } },
    select: { id: true },
  });

  const deal = await db.deal.create({
    data: {
      organizationId: ctx.orgId,
      title: input.title,
      valueCents: input.valueCents,
      contactId: input.contactId,
      companyId: input.companyId,
      pipelineId: stage.id,
      stageId: input.stageId,
      ownerId: ctx.userId,
      expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
    },
  });

  await audit(ctx, {
    action: "deal.create",
    resourceType: "deal",
    resourceId: deal.id,
    after: { title: input.title, valueCents: input.valueCents },
  });
  return deal;
}

export async function moveDeal(ctx: TenantContext, dealId: string, stageId: string) {
  const db = tenantDb(ctx.orgId);
  const deal = await db.deal.findFirstOrThrow({
    where: { id: dealId, deletedAt: null },
    include: { stage: true },
  });

  // stage must belong to a pipeline of this org (tenantDb scopes pipeline)
  const pipeline = await db.pipeline.findFirstOrThrow({
    where: { stages: { some: { id: stageId } } },
    include: { stages: { where: { id: stageId } } },
  });
  const newStage = pipeline.stages[0]!;

  const closed = newStage.isWon || newStage.isLost;
  await db.deal.update({
    where: { id: dealId },
    data: { stageId, ...(closed ? { closedAt: new Date() } : { closedAt: null }) },
  });

  await audit(ctx, {
    action: "deal.stage_change",
    resourceType: "deal",
    resourceId: dealId,
    before: { stage: deal.stage.name },
    after: { stage: newStage.name },
  });

  // Workflow triggers (§17.1)
  await emitWorkflowEvent(ctx.orgId, "deal.stage_changed", {
    dealId,
    from: deal.stage.name,
    to: newStage.name,
    valueCents: deal.valueCents,
  });
  if (newStage.isWon) {
    await emitWorkflowEvent(ctx.orgId, "deal.won", {
      dealId,
      title: deal.title,
      valueCents: deal.valueCents,
    });
  }
}
