import "server-only";

import { routeModel } from "@/server/ai/router";
import { anthropic } from "@/server/integrations/anthropic";
import { tenantDb, type TenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import { noteSubject } from "./contacts";
import { emitWorkflowEvent } from "./workflow-events";
import type { TenantContext } from "@/server/auth/session";
import type {
  DealInput,
  DealTaskInput,
  MoveDealInput,
  NoteInput,
  PipelineStageInput,
} from "@/lib/validators/crm";

/** How long won/lost deals remain visible on the board. */
const CLOSED_VISIBLE_DAYS = 30;

export class DealError extends Error {
  constructor(
    message: string,
    public readonly code:
      "stage_not_found" | "stage_has_deals" | "last_open_stage" | "cross_pipeline",
  ) {
    super(message);
    this.name = "DealError";
  }
}

/** Effective win probability: won=100, lost=0, else deal override or stage default. */
export function effectiveProbability(
  deal: { probability: number | null },
  stage: { probability: number; isWon: boolean; isLost: boolean },
): number {
  if (stage.isWon) return 100;
  if (stage.isLost) return 0;
  return deal.probability ?? stage.probability;
}

/** Probability-weighted revenue in cents. */
export function expectedRevenueCents(valueCents: number, probability: number): number {
  return Math.round((valueCents * probability) / 100);
}

/** Kanban board data: default pipeline + ordered stages + visible deals. */
export async function getBoard(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const closedCutoff = new Date(Date.now() - CLOSED_VISIBLE_DAYS * 24 * 60 * 60 * 1000);

  const pipeline = await db.pipeline.findFirst({
    where: { isDefault: true },
    include: {
      stages: {
        orderBy: { order: "asc" },
        include: {
          deals: {
            where: {
              deletedAt: null,
              organizationId: ctx.orgId,
              OR: [{ closedAt: null }, { closedAt: { gte: closedCutoff } }],
            },
            orderBy: [{ position: "asc" }, { updatedAt: "desc" }],
            include: {
              contact: { select: { id: true, firstName: true, lastName: true } },
              company: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  return pipeline;
}

/** Deal detail: relations, ordered pipeline stages, timeline and tasks. */
export async function getDeal(ctx: TenantContext, dealId: string) {
  const db = tenantDb(ctx.orgId);
  const deal = await db.deal.findFirst({
    where: { id: dealId, deletedAt: null },
    include: {
      stage: true,
      pipeline: { include: { stages: { orderBy: { order: "asc" } } } },
      contact: {
        select: { id: true, firstName: true, lastName: true, email: true, deletedAt: true },
      },
      company: { select: { id: true, name: true, deletedAt: true } },
    },
  });
  if (!deal) return null;

  const [timeline, tasks] = await Promise.all([
    db.activity.findMany({
      where: { dealId, type: { not: "TASK" } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { id: true, fullName: true } } },
    }),
    db.activity.findMany({
      where: { dealId, type: "TASK" },
      orderBy: [{ completedAt: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: { user: { select: { id: true, fullName: true } } },
    }),
  ]);

  return { ...deal, timeline, tasks };
}

/** Assignable owners = members of the organization. */
export async function listOwnerOptions(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const members = await db.organizationMember.findMany({
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { joinedAt: "asc" },
    take: 500,
  });
  return members.map((m) => ({
    id: m.user.id,
    name: m.user.fullName ?? m.user.email,
  }));
}

/** Active contacts as select options for the deal form. */
export async function listContactOptions(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const contacts = await db.contact.findMany({
    where: { deletedAt: null, archivedAt: null },
    orderBy: { firstName: "asc" },
    select: { id: true, firstName: true, lastName: true },
    take: 500,
  });
  return contacts.map((c) => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" "),
  }));
}

/** Throws unless the stage belongs to a pipeline of this tenant. Returns the stage. */
async function assertStageInTenant(db: TenantDb, stageId: string) {
  const pipeline = await db.pipeline.findFirst({
    where: { stages: { some: { id: stageId } } },
    include: { stages: { where: { id: stageId } } },
  });
  const stage = pipeline?.stages[0];
  if (!pipeline || !stage) throw new DealError("Stage not found in tenant", "stage_not_found");
  return { pipeline, stage };
}

/** Throws if the contact is missing, deleted, or belongs to another tenant. */
async function assertContactInTenant(db: TenantDb, contactId: string) {
  await db.contact.findFirstOrThrow({
    where: { id: contactId, deletedAt: null },
    select: { id: true },
  });
}

/** Throws if the company is missing, deleted, or belongs to another tenant. */
async function assertCompanyInTenant(db: TenantDb, companyId: string) {
  await db.company.findFirstOrThrow({
    where: { id: companyId, deletedAt: null },
    select: { id: true },
  });
}

/** Throws if the user is not a member of this organization. */
async function assertOwnerInTenant(db: TenantDb, userId: string) {
  await db.organizationMember.findFirstOrThrow({
    where: { userId },
    select: { id: true },
  });
}

export async function createDeal(ctx: TenantContext, input: DealInput) {
  const db = tenantDb(ctx.orgId);
  const { pipeline, stage } = await assertStageInTenant(db, input.stageId);
  if (input.contactId) await assertContactInTenant(db, input.contactId);
  if (input.companyId) await assertCompanyInTenant(db, input.companyId);
  if (input.ownerId) await assertOwnerInTenant(db, input.ownerId);

  const position = await db.deal.count({ where: { stageId: input.stageId, deletedAt: null } });
  const closed = stage.isWon || stage.isLost;

  const deal = await db.deal.create({
    data: {
      organizationId: ctx.orgId,
      title: input.title,
      valueCents: input.valueCents,
      currency: input.currency,
      probability: input.probability ?? null,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      pipelineId: pipeline.id,
      stageId: input.stageId,
      ownerId: input.ownerId ?? ctx.userId,
      position,
      expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
      closedAt: closed ? new Date() : null,
    },
  });

  await audit(ctx, {
    action: "deal.create",
    resourceType: "deal",
    resourceId: deal.id,
    after: { title: input.title, valueCents: input.valueCents, currency: input.currency },
  });
  return deal;
}

export async function updateDeal(ctx: TenantContext, dealId: string, input: DealInput) {
  const db = tenantDb(ctx.orgId);
  const before = await db.deal.findFirstOrThrow({
    where: { id: dealId, deletedAt: null },
    include: { stage: true },
  });
  if (input.contactId) await assertContactInTenant(db, input.contactId);
  if (input.companyId) await assertCompanyInTenant(db, input.companyId);
  if (input.ownerId) await assertOwnerInTenant(db, input.ownerId);

  const deal = await db.deal.update({
    where: { id: dealId },
    data: {
      title: input.title,
      valueCents: input.valueCents,
      currency: input.currency,
      probability: input.probability ?? null,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      ownerId: input.ownerId ?? before.ownerId,
      expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null,
    },
  });

  await audit(ctx, {
    action: "deal.update",
    resourceType: "deal",
    resourceId: dealId,
    before: { title: before.title, valueCents: before.valueCents },
    after: { title: input.title, valueCents: input.valueCents },
  });

  // Stage changes go through the same side effects as a board move.
  if (input.stageId !== before.stageId) {
    await moveDeal(ctx, { dealId, stageId: input.stageId, position: 0 });
  }
  return deal;
}

export async function moveDeal(ctx: TenantContext, input: MoveDealInput) {
  const db = tenantDb(ctx.orgId);
  const deal = await db.deal.findFirstOrThrow({
    where: { id: input.dealId, deletedAt: null },
    include: { stage: true },
  });

  const { pipeline, stage: newStage } = await assertStageInTenant(db, input.stageId);
  if (pipeline.id !== deal.pipelineId) {
    throw new DealError("Stage belongs to a different pipeline", "cross_pipeline");
  }

  // Reorder within the same stage: no timeline entry, no events.
  if (newStage.id === deal.stageId) {
    await db.deal.update({
      where: { id: input.dealId },
      data: { position: input.position },
    });
    return;
  }

  const closed = newStage.isWon || newStage.isLost;
  await db.deal.update({
    where: { id: input.dealId },
    data: {
      stageId: input.stageId,
      position: input.position,
      closedAt: closed ? new Date() : null,
      ...(newStage.isLost ? {} : { lostReason: null }),
    },
  });

  await db.activity.create({
    data: {
      organizationId: ctx.orgId,
      userId: ctx.userId,
      dealId: deal.id,
      contactId: deal.contactId,
      companyId: deal.companyId,
      type: "STAGE_CHANGE",
      subject: `${deal.stage.name} → ${newStage.name}`,
      metadata: { fromStageId: deal.stageId, toStageId: newStage.id },
    },
  });

  await audit(ctx, {
    action: "deal.stage_change",
    resourceType: "deal",
    resourceId: input.dealId,
    before: { stage: deal.stage.name },
    after: { stage: newStage.name },
  });

  await emitWorkflowEvent(ctx.orgId, "deal.stage_changed", {
    dealId: input.dealId,
    from: deal.stage.name,
    to: newStage.name,
    valueCents: deal.valueCents,
  });
  if (newStage.isWon) {
    await emitWorkflowEvent(ctx.orgId, "deal.won", {
      dealId: input.dealId,
      title: deal.title,
      valueCents: deal.valueCents,
    });
  }
}

export async function deleteDeal(ctx: TenantContext, dealId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const deal = await db.deal.findFirstOrThrow({ where: { id: dealId } });
  await db.deal.update({ where: { id: dealId }, data: { deletedAt: new Date() } });
  await audit(ctx, {
    action: "deal.delete",
    resourceType: "deal",
    resourceId: dealId,
    before: { title: deal.title, valueCents: deal.valueCents },
  });
}

/** Adds a NOTE activity to the deal timeline (mirrored to contact/company). */
export async function addDealNote(ctx: TenantContext, dealId: string, input: NoteInput) {
  const db = tenantDb(ctx.orgId);
  const deal = await db.deal.findFirstOrThrow({
    where: { id: dealId, deletedAt: null },
    select: { id: true, contactId: true, companyId: true },
  });

  const activity = await db.activity.create({
    data: {
      organizationId: ctx.orgId,
      userId: ctx.userId,
      dealId: deal.id,
      contactId: deal.contactId,
      companyId: deal.companyId,
      type: "NOTE",
      subject: noteSubject(input.body),
      body: input.body,
    },
  });

  await audit(ctx, {
    action: "deal.note",
    resourceType: "deal",
    resourceId: dealId,
    after: { activityId: activity.id },
  });
  return activity;
}

/** Adds a TASK activity (reminder) with an optional due date. */
export async function addDealTask(ctx: TenantContext, dealId: string, input: DealTaskInput) {
  const db = tenantDb(ctx.orgId);
  const deal = await db.deal.findFirstOrThrow({
    where: { id: dealId, deletedAt: null },
    select: { id: true, contactId: true, companyId: true },
  });

  const activity = await db.activity.create({
    data: {
      organizationId: ctx.orgId,
      userId: ctx.userId,
      dealId: deal.id,
      contactId: deal.contactId,
      companyId: deal.companyId,
      type: "TASK",
      subject: input.title,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
    },
  });

  await audit(ctx, {
    action: "deal.task.create",
    resourceType: "deal",
    resourceId: dealId,
    after: { activityId: activity.id, dueAt: input.dueAt ?? null },
  });
  return activity;
}

/** Toggles a deal task between open and completed. */
export async function toggleDealTask(
  ctx: TenantContext,
  dealId: string,
  taskId: string,
  completed: boolean,
) {
  const db = tenantDb(ctx.orgId);
  await db.activity.findFirstOrThrow({
    where: { id: taskId, dealId, type: "TASK" },
    select: { id: true },
  });

  const activity = await db.activity.update({
    where: { id: taskId },
    data: { completedAt: completed ? new Date() : null },
  });

  await audit(ctx, {
    action: completed ? "deal.task.complete" : "deal.task.reopen",
    resourceType: "deal",
    resourceId: dealId,
    after: { activityId: taskId },
  });
  return activity;
}

// ───────────────────────── Pipeline stage management ─────────────────────────

async function defaultPipeline(db: TenantDb) {
  return db.pipeline.findFirstOrThrow({
    where: { isDefault: true },
    include: { stages: { orderBy: { order: "asc" } } },
  });
}

export async function createStage(ctx: TenantContext, input: PipelineStageInput) {
  const db = tenantDb(ctx.orgId);
  const pipeline = await defaultPipeline(db);
  const nextOrder = (pipeline.stages.at(-1)?.order ?? -1) + 1;

  const stage = await db.pipelineStage.create({
    data: {
      pipelineId: pipeline.id,
      name: input.name,
      order: nextOrder,
      probability: input.kind === "won" ? 100 : input.kind === "lost" ? 0 : input.probability,
      isWon: input.kind === "won",
      isLost: input.kind === "lost",
    },
  });

  await audit(ctx, {
    action: "pipeline.stage.create",
    resourceType: "pipeline",
    resourceId: pipeline.id,
    after: { stageId: stage.id, name: input.name },
  });
  return stage;
}

export async function updateStage(ctx: TenantContext, stageId: string, input: PipelineStageInput) {
  const db = tenantDb(ctx.orgId);
  const { pipeline, stage: before } = await assertStageInTenant(db, stageId);

  const stage = await db.pipelineStage.update({
    where: { id: stageId },
    data: {
      name: input.name,
      probability: input.kind === "won" ? 100 : input.kind === "lost" ? 0 : input.probability,
      isWon: input.kind === "won",
      isLost: input.kind === "lost",
    },
  });

  await audit(ctx, {
    action: "pipeline.stage.update",
    resourceType: "pipeline",
    resourceId: pipeline.id,
    before: { name: before.name, probability: before.probability },
    after: { name: input.name, probability: input.probability },
  });
  return stage;
}

export async function deleteStage(ctx: TenantContext, stageId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const { pipeline, stage } = await assertStageInTenant(db, stageId);

  const dealCount = await db.deal.count({ where: { stageId, deletedAt: null } });
  if (dealCount > 0) throw new DealError("Stage still has deals", "stage_has_deals");

  if (!stage.isWon && !stage.isLost) {
    const openStages = await db.pipeline.findFirstOrThrow({
      where: { id: pipeline.id },
      include: { stages: { where: { isWon: false, isLost: false } } },
    });
    if (openStages.stages.length <= 1) {
      throw new DealError("Cannot delete the last open stage", "last_open_stage");
    }
  }

  await db.pipelineStage.delete({ where: { id: stageId } });
  await audit(ctx, {
    action: "pipeline.stage.delete",
    resourceType: "pipeline",
    resourceId: pipeline.id,
    before: { stageId, name: stage.name },
  });
}

// ───────────────────────── AI insights ─────────────────────────

const INSIGHTS_LANGUAGE: Record<string, string> = {
  en: "English",
  fi: "Finnish",
  ar: "Arabic",
};

/** Builds the model prompt from deal state. Exported for tests. */
export function buildInsightsPrompt(deal: {
  title: string;
  valueCents: number;
  currency: string;
  probability: number;
  stageName: string;
  stageNames: string[];
  expectedCloseAt: Date | null;
  contactName: string | null;
  companyName: string | null;
  openTasks: { subject: string; dueAt: Date | null }[];
  recentActivities: { type: string; subject: string; createdAt: Date }[];
}): string {
  const lines = [
    `Deal: ${deal.title}`,
    `Value: ${(deal.valueCents / 100).toFixed(2)} ${deal.currency}`,
    `Win probability: ${deal.probability}%`,
    `Current stage: ${deal.stageName} (pipeline: ${deal.stageNames.join(" → ")})`,
    `Expected close: ${deal.expectedCloseAt ? deal.expectedCloseAt.toISOString().slice(0, 10) : "not set"}`,
    `Contact: ${deal.contactName ?? "none"}`,
    `Company: ${deal.companyName ?? "none"}`,
    `Open tasks: ${
      deal.openTasks.length === 0
        ? "none"
        : deal.openTasks
            .map(
              (t) => `${t.subject}${t.dueAt ? ` (due ${t.dueAt.toISOString().slice(0, 10)})` : ""}`,
            )
            .join("; ")
    }`,
    "Recent activity:",
    ...(deal.recentActivities.length === 0
      ? ["- none"]
      : deal.recentActivities.map(
          (a) => `- [${a.createdAt.toISOString().slice(0, 10)}] ${a.type}: ${a.subject}`,
        )),
  ];
  return lines.join("\n");
}

/**
 * Generates AI insights + next-step recommendations for a deal and stores
 * them on the timeline as an AI_SUMMARY activity.
 */
export async function generateDealInsights(ctx: TenantContext, dealId: string) {
  const deal = await getDeal(ctx, dealId);
  if (!deal) throw new DealError("Deal not found", "stage_not_found");

  const probability = effectiveProbability(deal, deal.stage);
  const prompt = buildInsightsPrompt({
    title: deal.title,
    valueCents: deal.valueCents,
    currency: deal.currency,
    probability,
    stageName: deal.stage.name,
    stageNames: deal.pipeline.stages.map((s) => s.name),
    expectedCloseAt: deal.expectedCloseAt,
    contactName: deal.contact
      ? [deal.contact.firstName, deal.contact.lastName].filter(Boolean).join(" ")
      : null,
    companyName: deal.company?.name ?? null,
    openTasks: deal.tasks
      .filter((t) => !t.completedAt)
      .slice(0, 10)
      .map((t) => ({ subject: t.subject, dueAt: t.dueAt })),
    recentActivities: deal.timeline
      .slice(0, 15)
      .map((a) => ({ type: a.type, subject: a.subject, createdAt: a.createdAt })),
  });

  const language = INSIGHTS_LANGUAGE[ctx.locale] ?? "English";
  const route = routeModel("summary");
  const response = await anthropic.messages.create({
    model: route.model,
    max_tokens: route.maxTokens,
    system:
      `You are a sales coach inside Syveka AI, a Finnish CRM. Analyse the deal ` +
      `and reply in ${language} with: (1) a one-sentence health assessment, ` +
      `(2) key risks, (3) 2-3 concrete next steps. Be brief and practical. ` +
      `Plain text only, no markdown headers.`,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  const db = tenantDb(ctx.orgId);
  const activity = await db.activity.create({
    data: {
      organizationId: ctx.orgId,
      userId: ctx.userId,
      dealId: deal.id,
      contactId: deal.contactId,
      companyId: deal.companyId,
      type: "AI_SUMMARY",
      subject: noteSubject(text) || "AI insights",
      body: text,
      metadata: { model: route.model, kind: "deal_insights" },
    },
  });

  await audit(ctx, {
    action: "deal.ai_insights",
    resourceType: "deal",
    resourceId: dealId,
    after: { activityId: activity.id, model: route.model },
  });
  return activity;
}
