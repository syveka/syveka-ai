import "server-only";

import type { Plan } from "@/generated/prisma/client/client";
import { DEEP_MODEL_PLANS } from "@/lib/billing/plan-catalog";
import { routeModel } from "./router";

/** Whether an organization on this plan may run chat on the "deep" model. */
export function planAllowsDeepModel(plan: Plan): boolean {
  return DEEP_MODEL_PLANS.has(plan);
}

/**
 * The model a conversation's stored pin may run on, or null to use the normal
 * route. A pin is honored only for a model the plan may use, so a stored value
 * can never buy a more expensive model than the plan includes, or an unknown one.
 */
export function permittedPinnedModel(pinned: string | null, plan: Plan): string | null {
  if (!pinned) return null;
  if (pinned === routeModel("chat").model) return pinned;
  if (pinned === routeModel("deep").model && planAllowsDeepModel(plan)) return pinned;
  return null;
}
