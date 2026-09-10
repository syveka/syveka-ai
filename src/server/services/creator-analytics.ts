import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";

/**
 * Read-side aggregation over existing Creator Studio tables (Phase 16) —
 * same pattern as src/server/services/analytics.ts (CRM dashboard metrics):
 * no separate write-side event log, computed on demand from
 * CreatorGeneration/CreatorPost/CreatorCreditTransaction directly.
 * Content-performance (views/likes/reach) is intentionally out of scope for
 * v1 — every real social platform adapter is "blocked" (Phase 11), so there
 * is no live metrics source to aggregate yet.
 */
export async function getCreatorGenerationAnalytics(ctx: TenantContext) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);

  const [byTypeStatus, creditsAgg, latencyAgg] = await Promise.all([
    db.creatorGeneration.groupBy({
      by: ["generationType", "status"],
      _count: { _all: true },
    }),
    db.creatorGeneration.aggregate({ _sum: { creditsConsumed: true } }),
    db.creatorGeneration.aggregate({ _avg: { latencyMs: true }, where: { status: "COMPLETED" } }),
  ]);

  return {
    byTypeStatus: byTypeStatus.map((row) => ({
      generationType: row.generationType,
      status: row.status,
      count: row._count._all,
    })),
    creditsConsumedTotal: creditsAgg._sum.creditsConsumed ?? 0,
    averageLatencyMs: Math.round(latencyAgg._avg.latencyMs ?? 0),
  };
}

export async function getCreatorPublishingAnalytics(ctx: TenantContext) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);

  const [byPlatformStatus, autopilotVsManual, approvalTurnaround] = await Promise.all([
    db.creatorPost.groupBy({ by: ["platform", "publishStatus"], _count: { _all: true } }),
    db.creatorPost.groupBy({
      by: ["publishStatus"],
      where: { campaign: { autopilotEnabled: true } },
      _count: { _all: true },
    }),
    db.creatorPost.findMany({
      where: { approvedAt: { not: null } },
      select: { createdAt: true, approvedAt: true },
      take: 500,
    }),
  ]);

  const turnaroundMs = approvalTurnaround
    .filter((p) => p.approvedAt)
    .map((p) => p.approvedAt!.getTime() - p.createdAt.getTime());
  const avgApprovalTurnaroundMs =
    turnaroundMs.length > 0
      ? Math.round(turnaroundMs.reduce((a, b) => a + b, 0) / turnaroundMs.length)
      : 0;

  return {
    byPlatformStatus: byPlatformStatus.map((row) => ({
      platform: row.platform,
      publishStatus: row.publishStatus,
      count: row._count._all,
    })),
    autopilotPublishedCount: autopilotVsManual
      .filter((r) => r.publishStatus === "PUBLISHED")
      .reduce((sum, r) => sum + r._count._all, 0),
    avgApprovalTurnaroundMs,
  };
}
