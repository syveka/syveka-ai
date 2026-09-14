import "server-only";

import type { EntitlementMetric, Plan, Prisma, UsageMetric } from "@prisma/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { redis } from "@/server/integrations/redis";
import { PLAN_LIMITS, type PlanLimits } from "./plans";

export type Entitlements = PlanLimits & {
  plan: Plan;
  seats: number;
  status: string;
  readOnly: boolean; // PAST_DUE ≥ 14d or CANCELED over-limit lockout (§14.4)
};

/**
 * Internal/pilot entitlement overrides -- never a Stripe subscription,
 * never a change to Subscription.plan. See prisma/schema.prisma's
 * EntitlementGrant doc comment. Only PlanLimits' numeric fields are
 * grantable -- apiAccess is a boolean, not an additive amount, and is
 * deliberately excluded from both the Prisma enum and this map.
 */
export const METRIC_TO_PLAN_LIMIT_KEY: Record<
  EntitlementMetric,
  Exclude<keyof PlanLimits, "apiAccess">
> = {
  MAX_SEATS: "maxSeats",
  AI_MESSAGES_PER_USER_MONTH: "aiMessagesPerUserMonth",
  VOICE_ASSISTANTS: "voiceAssistants",
  VOICE_MINUTES_MONTH: "voiceMinutesMonth",
  KB_STORAGE_MB: "kbStorageMb",
  ACTIVE_WORKFLOWS: "activeWorkflows",
  MAX_CONTACTS: "maxContacts",
  AUDIT_RETENTION_DAYS: "auditRetentionDays",
  CREATOR_CREDITS_PER_MONTH: "creatorCreditsPerMonth",
};

export type ActiveGrant = {
  id: string;
  metric: EntitlementMetric;
  amount: number;
  reason: string;
  grantedByUserId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
};

/** Active = not revoked and not expired. Used by getEntitlements()'s merge and the admin list view. */
export async function listActiveGrants(orgId: string): Promise<ActiveGrant[]> {
  return unscopedPrisma.entitlementGrant.findMany({
    where: {
      organizationId: orgId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: {
      id: true,
      metric: true,
      amount: true,
      reason: true,
      grantedByUserId: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/** All grants for an org (active, expired, and revoked) -- admin history view only. */
export async function listAllGrants(orgId: string) {
  return unscopedPrisma.entitlementGrant.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
  });
}

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

/**
 * Plan → limits, Redis-cached 60s (§14.2). Invalidated by the Stripe
 * webhook, and by grantEntitlementOverride()/revokeEntitlementOverride()
 * (./entitlement-grants.ts). Effective entitlement = plan entitlement +
 * sum(active internal grants) per metric -- additive only, so a grant can
 * never reduce what the plan itself already grants, and ENTERPRISE's
 * Number.MAX_SAFE_INTEGER "unlimited" fields are capped rather than summed
 * past that value (adding a finite grant on top of "unlimited" must still
 * read as unlimited, not as a slightly-larger-but-still-finite number).
 * Subscription.plan/status/seats are never touched by a grant -- billing
 * truth stays exactly what Stripe (or the FREE default) says it is.
 */
export async function getEntitlements(orgId: string): Promise<Entitlements> {
  const cacheKey = `ent:${orgId}`;
  const cached = await redis.get<Entitlements>(cacheKey);
  if (cached) return cached;

  const [sub, activeGrants] = await Promise.all([
    unscopedPrisma.subscription.findUnique({ where: { organizationId: orgId } }),
    listActiveGrants(orgId),
  ]);

  const plan: Plan = sub?.plan ?? "FREE";
  const status = sub?.status ?? "ACTIVE";

  const pastDueTooLong =
    status === "PAST_DUE" &&
    sub?.updatedAt !== undefined &&
    Date.now() - sub.updatedAt.getTime() > 14 * 24 * 60 * 60 * 1000;

  const limits: PlanLimits = { ...PLAN_LIMITS[plan] };
  for (const grant of activeGrants) {
    const key = METRIC_TO_PLAN_LIMIT_KEY[grant.metric];
    limits[key] = Math.min(Number.MAX_SAFE_INTEGER, limits[key] + grant.amount);
  }

  const ent: Entitlements = {
    ...limits,
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
