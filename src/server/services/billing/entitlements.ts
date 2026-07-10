import "server-only";

import type { Plan, Prisma, UsageMetric } from "@prisma/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { redis } from "@/server/integrations/redis";
import { PLAN_LIMITS, type PlanLimits } from "./plans";

export type Entitlements = PlanLimits & {
  plan: Plan;
  seats: number;
  status: string;
  readOnly: boolean; // PAST_DUE ≥ 14d or CANCELED over-limit lockout (§14.4)
};

export class EntitlementError extends Error {
  readonly code = "entitlement_exceeded";
  constructor(
    public readonly limit: keyof PlanLimits,
    message: string,
  ) {
    super(message);
  }
}

const CACHE_TTL_SECONDS = 60;

/** Plan → limits, Redis-cached 60s (§14.2). Invalidated by the Stripe webhook. */
export async function getEntitlements(orgId: string): Promise<Entitlements> {
  const cacheKey = `ent:${orgId}`;
  const cached = await redis.get<Entitlements>(cacheKey);
  if (cached) return cached;

  const sub = await unscopedPrisma.subscription.findUnique({
    where: { organizationId: orgId },
  });

  const plan: Plan = sub?.plan ?? "FREE";
  const status = sub?.status ?? "ACTIVE";

  const pastDueTooLong =
    status === "PAST_DUE" &&
    sub?.updatedAt !== undefined &&
    Date.now() - sub.updatedAt.getTime() > 14 * 24 * 60 * 60 * 1000;

  const ent: Entitlements = {
    ...PLAN_LIMITS[plan],
    plan,
    seats: sub?.seats ?? 1,
    status,
    readOnly: pastDueTooLong,
  };

  await redis.set(cacheKey, ent, { ex: CACHE_TTL_SECONDS });
  return ent;
}

export async function invalidateEntitlements(orgId: string): Promise<void> {
  await redis.del(`ent:${orgId}`);
}

/** Current-month usage for a metric (rolled up nightly + live tail). */
export async function getMonthUsage(orgId: string, metric: UsageMetric): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const agg = await unscopedPrisma.usageRecord.aggregate({
    where: { organizationId: orgId, metric, periodStart: { gte: monthStart } },
    _sum: { quantity: true },
  });
  return agg._sum.quantity ?? 0;
}

export async function recordUsage(
  orgId: string,
  metric: UsageMetric,
  quantity: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const periodStart = new Date();
  periodStart.setUTCHours(0, 0, 0, 0);
  await unscopedPrisma.usageRecord.create({
    data: {
      organizationId: orgId,
      metric,
      quantity,
      periodStart,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
}

/** Guard used at AI chat start, uploads, workflow activation, invites (§14.2). */
export async function assertWithinLimit(
  orgId: string,
  check:
    | { kind: "ai_messages"; userMonthCount: number }
    | { kind: "voice_minutes" }
    | { kind: "contacts"; current: number }
    | { kind: "workflows"; active: number }
    | { kind: "seats"; current: number }
    | { kind: "storage_mb"; currentMb: number },
): Promise<Entitlements> {
  const ent = await getEntitlements(orgId);
  if (ent.readOnly) {
    throw new EntitlementError("maxSeats", "Subscription is past due — workspace is read-only.");
  }

  switch (check.kind) {
    case "ai_messages":
      if (check.userMonthCount >= ent.aiMessagesPerUserMonth) {
        throw new EntitlementError("aiMessagesPerUserMonth", "Monthly AI message quota reached.");
      }
      break;
    case "voice_minutes": {
      const used = await getMonthUsage(orgId, "VOICE_MINUTES");
      if (used >= ent.voiceMinutesMonth) {
        throw new EntitlementError("voiceMinutesMonth", "Monthly voice minutes exhausted.");
      }
      break;
    }
    case "contacts":
      if (check.current >= ent.maxContacts) {
        throw new EntitlementError("maxContacts", "Contact limit reached for your plan.");
      }
      break;
    case "workflows":
      if (check.active >= ent.activeWorkflows) {
        throw new EntitlementError("activeWorkflows", "Active workflow limit reached.");
      }
      break;
    case "seats":
      if (check.current >= ent.maxSeats) {
        throw new EntitlementError("maxSeats", "Seat limit reached for your plan.");
      }
      break;
    case "storage_mb":
      if (check.currentMb >= ent.kbStorageMb) {
        throw new EntitlementError("kbStorageMb", "Knowledge base storage limit reached.");
      }
      break;
  }
  return ent;
}
