import "server-only";

import { Prisma, type CreatorGenerationType } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { getEntitlements } from "./billing/entitlements";

/**
 * Creator Studio credit system (Phase 2): a server-side-only reserve →
 * commit/release ledger, separate from the general UsageRecord metering
 * (§ CLAUDE.md — pricing stays server-side and never client-supplied).
 * Concurrent overspending is prevented by an atomic conditional UPDATE
 * (`availableCredits >= amount` in the WHERE clause) rather than a
 * read-then-write check — Postgres serializes concurrent UPDATEs on the
 * same row, so two simultaneous reservations can never both succeed past
 * the available balance.
 */

export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
}

type GenerationCostOptions = {
  quality?: "standard" | "high";
  durationSeconds?: number;
};

/** Base cost in credits per generation type. Server-side only — never trust a client-supplied cost. */
const BASE_CREDIT_COST: Record<CreatorGenerationType, number> = {
  IMAGE: 10,
  IMAGE_TO_VIDEO: 60,
  CAPTION: 1,
  VOICE: 20,
  CAMPAIGN_ASSET: 15,
};

/** Per-provider cost multiplier — the only place a new real provider's pricing is registered. */
const PROVIDER_COST_MULTIPLIER: Record<string, number> = {
  mock: 1,
};

/**
 * Central, provider/model/tier-agnostic pricing function (Phase 2). Never
 * hardcode a generation's credit cost anywhere else — every caller that
 * reserves credits must derive the amount from this function.
 */
export function getCreatorGenerationCreditCost(
  type: CreatorGenerationType,
  provider: string,
  _model: string,
  options: GenerationCostOptions = {},
): number {
  const base = BASE_CREDIT_COST[type];
  const providerMultiplier = PROVIDER_COST_MULTIPLIER[provider] ?? 1;
  const qualityMultiplier = options.quality === "high" ? 1.5 : 1;
  const durationMultiplier =
    type === "IMAGE_TO_VIDEO" && options.durationSeconds
      ? Math.max(1, options.durationSeconds / 5)
      : 1;
  return Math.max(
    1,
    Math.round(base * providerMultiplier * qualityMultiplier * durationMultiplier),
  );
}

function monthStart(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Idempotent monthly plan-based credit grant. Safe to call on every balance
 * read/reserve — the unique (organizationId, periodStart) constraint on
 * CreatorCreditGrant means a duplicate grant attempt is a no-op, not a
 * double-credit.
 */
export async function ensureMonthlyCreditGrant(orgId: string): Promise<void> {
  const periodStart = monthStart();
  const ent = await getEntitlements(orgId);
  const amount = ent.creatorCreditsPerMonth;
  if (amount <= 0) return;

  await unscopedPrisma.$transaction(async (tx) => {
    try {
      await tx.creatorCreditGrant.create({ data: { organizationId: orgId, periodStart, amount } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return; // already granted this period
      }
      throw e;
    }
    await tx.creatorCreditBalance.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, availableCredits: amount, reservedCredits: 0 },
      update: { availableCredits: { increment: amount } },
    });
    await tx.creatorCreditTransaction.create({
      data: { organizationId: orgId, type: "GRANT", amount, reason: "monthly_plan_grant" },
    });
  });
}

export async function getCreatorCreditBalance(
  ctx: TenantContext,
): Promise<{ availableCredits: number; reservedCredits: number }> {
  await ensureMonthlyCreditGrant(ctx.orgId);
  const balance = await tenantDb(ctx.orgId).creatorCreditBalance.findUnique({
    where: { organizationId: ctx.orgId },
  });
  return {
    availableCredits: balance?.availableCredits ?? 0,
    reservedCredits: balance?.reservedCredits ?? 0,
  };
}

/** Reserve credits before running a paid provider call. Throws InsufficientCreditsError if unavailable. */
export async function reserveCreatorCredits(
  ctx: TenantContext,
  params: { generationId: string; amount: number },
): Promise<void> {
  await ensureMonthlyCreditGrant(ctx.orgId);

  const db = tenantDb(ctx.orgId);
  const result = await db.creatorCreditBalance.updateMany({
    where: { organizationId: ctx.orgId, availableCredits: { gte: params.amount } },
    data: {
      availableCredits: { decrement: params.amount },
      reservedCredits: { increment: params.amount },
    },
  });
  if (result.count !== 1) {
    throw new InsufficientCreditsError("Insufficient Creator Studio credits for this generation.");
  }

  await unscopedPrisma.creatorCreditTransaction.create({
    data: {
      organizationId: ctx.orgId,
      generationId: params.generationId,
      type: "RESERVE",
      amount: params.amount,
      createdById: ctx.userId,
    },
  });
}

/** Finalize the actual debit after a successful generation; refunds any unused reservation. */
export async function commitCreatorCredits(
  ctx: TenantContext,
  params: { generationId: string; reservedAmount: number; actualAmount: number },
): Promise<void> {
  const refund = Math.max(0, params.reservedAmount - params.actualAmount);
  const db = tenantDb(ctx.orgId);
  await db.creatorCreditBalance.updateMany({
    where: { organizationId: ctx.orgId },
    data: {
      reservedCredits: { decrement: params.reservedAmount },
      ...(refund > 0 ? { availableCredits: { increment: refund } } : {}),
    },
  });
  await unscopedPrisma.creatorCreditTransaction.create({
    data: {
      organizationId: ctx.orgId,
      generationId: params.generationId,
      type: "COMMIT",
      amount: params.actualAmount,
      createdById: ctx.userId,
    },
  });
}

/** Release a reservation in full on generation failure — never leaves credits stuck as "reserved". */
export async function releaseCreatorCredits(
  ctx: TenantContext,
  params: { generationId: string; amount: number; reason: string },
): Promise<void> {
  const db = tenantDb(ctx.orgId);
  await db.creatorCreditBalance.updateMany({
    where: { organizationId: ctx.orgId },
    data: {
      reservedCredits: { decrement: params.amount },
      availableCredits: { increment: params.amount },
    },
  });
  await unscopedPrisma.creatorCreditTransaction.create({
    data: {
      organizationId: ctx.orgId,
      generationId: params.generationId,
      type: "RELEASE",
      amount: params.amount,
      reason: params.reason,
      createdById: ctx.userId,
    },
  });
}
