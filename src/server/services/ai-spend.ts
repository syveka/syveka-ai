import "server-only";

import type { TenantContext } from "@/server/auth/session";
import { limitAiChat } from "@/server/integrations/redis";
import {
  assertWithinLimit,
  EntitlementError,
  getMonthUsage,
  recordUsage,
} from "@/server/services/billing/entitlements";

export class AiSpendError extends Error {
  constructor(readonly code: "rate_limited" | "quota") {
    super(code === "quota" ? "Monthly AI message quota reached." : "Too many AI requests.");
    this.name = "AiSpendError";
  }
}

/**
 * Gate for an AI feature outside chat (deal insights, scheduling assistant, meeting summary,
 * email drafts): the same per-user and per-organization rate limits and monthly AI message
 * quota as chat, so these paid calls can't be repeated without bound.
 */
export async function assertAiSpendAllowed(ctx: TenantContext): Promise<void> {
  const rateLimit = await limitAiChat(ctx.orgId, ctx.userId);
  if (!rateLimit.success) throw new AiSpendError("rate_limited");
  await assertAiQuotaAvailable(ctx.orgId);
}

/**
 * The organization-wide half of assertAiSpendAllowed: the monthly AI message quota (and the
 * read-only lockout), without the per-user rate limit. For AI calls made with no user behind
 * them, such as a workflow's ai.generate step.
 */
export async function assertAiQuotaAvailable(orgId: string): Promise<void> {
  const orgMonthCount = await getMonthUsage(orgId, "AI_MESSAGES");
  try {
    await assertWithinLimit(orgId, { kind: "ai_messages", orgMonthCount });
  } catch (error) {
    if (error instanceof EntitlementError) throw new AiSpendError("quota");
    throw error;
  }
}

/** Counts one completed AI feature call against the monthly AI message quota. */
export async function recordAiSpend(ctx: TenantContext, feature: string): Promise<void> {
  await recordUsage(ctx.orgId, "AI_MESSAGES", 1, { userId: ctx.userId, feature });
}
