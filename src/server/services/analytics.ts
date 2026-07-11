import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";

function monthStart(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

export async function getSalesAnalytics(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const pipeline = await db.pipeline.findFirst({
    where: { isDefault: true },
    include: {
      stages: {
        orderBy: { order: "asc" },
        include: {
          deals: {
            where: { deletedAt: null, organizationId: ctx.orgId },
            select: { valueCents: true, closedAt: true, createdAt: true },
          },
        },
      },
    },
  });

  const funnel = (pipeline?.stages ?? []).map((s) => ({
    stage: s.name,
    isWon: s.isWon,
    isLost: s.isLost,
    count: s.deals.length,
    valueCents: s.deals.reduce((sum, d) => sum + d.valueCents, 0),
  }));

  const won = funnel.filter((s) => s.isWon).reduce((n, s) => n + s.count, 0);
  const lost = funnel.filter((s) => s.isLost).reduce((n, s) => n + s.count, 0);
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;

  return { funnel, winRate };
}

export async function getAiAnalytics(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const since = daysAgo(30);

  const [byDay, tokens, feedback] = await Promise.all([
    db.usageRecord.groupBy({
      by: ["periodStart"],
      where: { metric: "AI_MESSAGES", periodStart: { gte: since } },
      _sum: { quantity: true },
      orderBy: { periodStart: "asc" },
    }),
    db.usageRecord.groupBy({
      by: ["metric"],
      where: {
        metric: { in: ["AI_TOKENS_IN", "AI_TOKENS_OUT"] },
        periodStart: { gte: monthStart() },
      },
      _sum: { quantity: true },
    }),
    db.conversation.findMany({
      where: { updatedAt: { gte: since } },
      select: { messages: { where: { feedback: { not: null } }, select: { feedback: true } } },
    }),
  ]);

  const ratings = feedback.flatMap((c) => c.messages.map((m) => m.feedback ?? 0));
  const positive = ratings.filter((r) => r > 0).length;

  return {
    messagesByDay: byDay.map((d) => ({
      date: d.periodStart.toISOString().slice(0, 10),
      count: d._sum.quantity ?? 0,
    })),
    tokensIn: tokens.find((t) => t.metric === "AI_TOKENS_IN")?._sum.quantity ?? 0,
    tokensOut: tokens.find((t) => t.metric === "AI_TOKENS_OUT")?._sum.quantity ?? 0,
    feedbackPositivePct: ratings.length > 0 ? Math.round((positive / ratings.length) * 100) : null,
  };
}

export async function getVoiceAnalytics(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const since = daysAgo(30);

  const calls = await db.voiceCall.findMany({
    where: { startedAt: { gte: since } },
    select: { startedAt: true, durationSeconds: true, sentiment: true, status: true },
  });

  const byDay = new Map<string, number>();
  for (const c of calls) {
    const key = c.startedAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  const sentiments = { positive: 0, neutral: 0, negative: 0 };
  for (const c of calls) {
    if (c.sentiment && c.sentiment in sentiments) {
      sentiments[c.sentiment as keyof typeof sentiments]++;
    }
  }

  return {
    totalCalls: calls.length,
    totalMinutes: Math.round(calls.reduce((s, c) => s + (c.durationSeconds ?? 0), 0) / 60),
    transferred: calls.filter((c) => c.status === "TRANSFERRED").length,
    callsByDay: [...byDay.entries()].sort().map(([date, count]) => ({ date, count })),
    sentiments,
  };
}
