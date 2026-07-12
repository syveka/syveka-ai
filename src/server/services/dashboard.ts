import "server-only";

import { routeModel } from "@/server/ai/router";
import { can } from "@/server/auth/permissions";
import type { TenantContext } from "@/server/auth/session";
import { tenantDb } from "@/server/db/tenant";

function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysAgo(days: number): Date {
  return addDays(startOfUtcDay(), -days);
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function getCrmDashboard(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const permissions = {
    canReadCalendar: can(ctx.role, "calendar:read"),
    canUseChat: can(ctx.role, "chat:use"),
    canViewBilling: can(ctx.role, "billing:view"),
    canWriteCrm: can(ctx.role, "crm:write"),
  };
  const todayStart = startOfUtcDay();
  const tomorrowStart = addDays(todayStart, 1);
  const now = new Date();
  const nextWeek = addDays(now, 7);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentWindowStart = daysAgo(30);
  const previousWindowStart = daysAgo(60);

  const [
    totalCustomers,
    currentCustomers,
    previousCustomers,
    activeDeals,
    revenue,
    tasksDueToday,
    overdueTasks,
    recentActivities,
    recentTasks,
    pipeline,
    aiConversations,
    aiMessagesThisMonth,
    recentConversations,
    subscription,
    upcomingMeetings,
  ] = await Promise.all([
    db.contact.count({ where: { deletedAt: null, status: "CUSTOMER" } }),
    db.contact.count({
      where: { deletedAt: null, status: "CUSTOMER", createdAt: { gte: currentWindowStart } },
    }),
    db.contact.count({
      where: {
        deletedAt: null,
        status: "CUSTOMER",
        createdAt: { gte: previousWindowStart, lt: currentWindowStart },
      },
    }),
    db.deal.count({ where: { deletedAt: null, closedAt: null } }),
    db.deal.aggregate({
      where: { deletedAt: null, stage: { isWon: true }, closedAt: { gte: monthStart } },
      _sum: { valueCents: true },
    }),
    db.activity.count({
      where: {
        type: "TASK",
        completedAt: null,
        dueAt: { gte: todayStart, lt: tomorrowStart },
      },
    }),
    db.activity.count({
      where: { type: "TASK", completedAt: null, dueAt: { lt: todayStart } },
    }),
    db.activity.findMany({
      where: { type: { in: ["NOTE", "CALL", "EMAIL", "MEETING", "VOICE_AI_CALL", "AI_SUMMARY"] } },
      orderBy: { createdAt: "desc" },
      take: 4,
      include: {
        contact: { select: { firstName: true, lastName: true } },
        deal: { select: { title: true } },
      },
    }),
    db.activity.findMany({
      where: { type: "TASK" },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 4,
      include: {
        contact: { select: { firstName: true, lastName: true } },
        deal: { select: { title: true } },
      },
    }),
    db.pipeline.findFirst({
      where: { isDefault: true },
      include: {
        stages: {
          orderBy: { order: "asc" },
        },
      },
    }),
    permissions.canUseChat
      ? db.conversation.count({ where: { deletedAt: null, updatedAt: { gte: monthStart } } })
      : Promise.resolve(0),
    permissions.canUseChat
      ? db.usageRecord.aggregate({
          where: { metric: "AI_MESSAGES", periodStart: { gte: monthStart } },
          _sum: { quantity: true },
        })
      : Promise.resolve({ _sum: { quantity: null } }),
    permissions.canUseChat
      ? db.conversation.findMany({
          where: { deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 4,
          select: { id: true, title: true, updatedAt: true, model: true },
        })
      : Promise.resolve([]),
    permissions.canViewBilling
      ? db.subscription.findFirst({ orderBy: { updatedAt: "desc" } })
      : Promise.resolve(null),
    permissions.canReadCalendar
      ? db.calendarEvent.findMany({
          where: { startsAt: { gte: now, lte: nextWeek } },
          orderBy: { startsAt: "asc" },
          take: 5,
        })
      : Promise.resolve([]),
  ]);

  const [stageDealTotals, upcomingTasks] = await Promise.all([
    pipeline
      ? db.deal.groupBy({
          by: ["stageId"],
          where: { pipelineId: pipeline.id, deletedAt: null, closedAt: null },
          _count: { _all: true },
          _sum: { valueCents: true },
        })
      : Promise.resolve([]),
    db.activity.findMany({
      where: { type: "TASK", completedAt: null, dueAt: { gte: now, lte: nextWeek } },
      orderBy: { dueAt: "asc" },
      take: 5,
      include: {
        contact: { select: { firstName: true, lastName: true } },
        deal: { select: { title: true } },
      },
    }),
  ]);

  const stageTotalsById = new Map(
    stageDealTotals.map((stage) => [
      stage.stageId,
      { count: stage._count._all, valueCents: stage._sum.valueCents ?? 0 },
    ]),
  );

  const pipelineStages =
    pipeline?.stages.map((stage) => {
      const totals = stageTotalsById.get(stage.id) ?? { count: 0, valueCents: 0 };
      return {
        id: stage.id,
        name: stage.name,
        count: totals.count,
        valueCents: totals.valueCents,
        isWon: stage.isWon,
        isLost: stage.isLost,
      };
    }) ?? [];

  const openPipelineValueCents = pipelineStages
    .filter((stage) => !stage.isWon && !stage.isLost)
    .reduce((sum, stage) => sum + stage.valueCents, 0);

  const summaryModel = routeModel("summary");
  const customerGrowthPct = percentChange(currentCustomers, previousCustomers);

  return {
    permissions,
    kpis: {
      totalCustomers,
      activeDeals,
      revenueCents: revenue._sum.valueCents ?? 0,
      tasksDueToday,
      aiConversations,
      aiMessagesThisMonth: aiMessagesThisMonth._sum.quantity ?? 0,
      customerGrowthPct,
    },
    feed: {
      customerActivities: recentActivities.map((activity) => ({
        id: activity.id,
        type: activity.type,
        subject: activity.subject,
        at: activity.createdAt,
        contactName: activity.contact
          ? [activity.contact.firstName, activity.contact.lastName].filter(Boolean).join(" ")
          : null,
        dealTitle: activity.deal?.title ?? null,
      })),
      aiActivities: recentConversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        at: conversation.updatedAt,
        model: conversation.model,
      })),
      payments: subscription
        ? [
            {
              id: subscription.id,
              plan: subscription.plan,
              status: subscription.status,
              at: subscription.updatedAt,
              currentPeriodEnd: subscription.currentPeriodEnd,
            },
          ]
        : [],
      tasks: recentTasks.map((task) => ({
        id: task.id,
        subject: task.subject,
        dueAt: task.dueAt,
        completedAt: task.completedAt,
        contactName: task.contact
          ? [task.contact.firstName, task.contact.lastName].filter(Boolean).join(" ")
          : null,
        dealTitle: task.deal?.title ?? null,
      })),
    },
    pipeline: {
      name: pipeline?.name ?? null,
      stages: pipelineStages,
      openValueCents: openPipelineValueCents,
    },
    calendar: {
      meetings: upcomingMeetings.map((event) => ({
        id: event.id,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        source: event.source,
      })),
      tasks: upcomingTasks.map((task) => ({
        id: task.id,
        subject: task.subject,
        dueAt: task.dueAt,
        contactName: task.contact
          ? [task.contact.firstName, task.contact.lastName].filter(Boolean).join(" ")
          : null,
        dealTitle: task.deal?.title ?? null,
      })),
    },
    insights: {
      model: summaryModel.model,
      provider: summaryModel.provider,
      activeDeals,
      overdueTasks,
      customerGrowthPct,
      aiMessagesThisMonth: aiMessagesThisMonth._sum.quantity ?? 0,
    },
  };
}

export type CrmDashboard = Awaited<ReturnType<typeof getCrmDashboard>>;
