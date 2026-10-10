import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";
import { liveActionStatus, type EvalClient } from "@/server/ai/tool-actions";

/**
 * Restores the AI write actions of saved chat messages, with their outcome,
 * when a conversation is opened again.
 *
 * The proposal itself is saved with the assistant message (its tool-call
 * log); its outcome comes only from the durable audit trail written by
 * POST /api/v1/ai/actions/{id} (`ai_action.confirm` / `ai_action.cancel`),
 * scoped to the organization. Nothing is inferred from the reply's wording
 * or from matching records: without an audit record the outcome is either
 * still pending (the server still decides it) or unknown ("unavailable"),
 * never "done" or "canceled".
 */

const OUTCOMES: Record<string, RestoredActionState> = {
  done: "done",
  canceled: "canceled",
  not_done: "slotTaken",
  stale: "stale",
  failed: "failed",
  unknown: "unknown",
};

/** Outcomes recorded for these actions in this organization (latest record wins). */
export async function recordedActionOutcomes(
  orgId: string,
  actionIds: string[],
): Promise<Map<string, RestoredActionState>> {
  const outcomes = new Map<string, RestoredActionState>();
  if (actionIds.length === 0) return outcomes;
  const rows = await unscopedPrisma.auditLog.findMany({
    where: {
      organizationId: orgId,
      resourceType: "ai_action",
      resourceId: { in: actionIds },
      action: { in: ["ai_action.confirm", "ai_action.cancel"] },
    },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true, resourceId: true, after: true },
  });
  for (const row of rows) {
    if (row.organizationId !== orgId || !row.resourceId) continue;
    const outcome = (row.after as { outcome?: unknown } | null)?.outcome;
    const state = typeof outcome === "string" ? OUTCOMES[outcome] : undefined;
    if (state) outcomes.set(row.resourceId, state);
  }
  return outcomes;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The action views saved in one message's tool-call log (malformed entries are ignored). */
export function savedActions(toolCalls: unknown): ProposedActionView[] {
  if (!Array.isArray(toolCalls)) return [];
  const actions: ProposedActionView[] = [];
  for (const entry of toolCalls) {
    const a = (entry as { action?: Partial<ProposedActionView> } | null)?.action;
    if (
      a &&
      typeof a.id === "string" &&
      UUID.test(a.id) &&
      typeof a.tool === "string" &&
      typeof a.digest === "string" &&
      typeof a.conversationId === "string" &&
      typeof a.expiresAt === "number" &&
      a.details !== null &&
      typeof a.details === "object" &&
      a.details.tool === a.tool
    ) {
      actions.push(a as ProposedActionView);
    }
  }
  return actions;
}

/** The live store's view of an unrecorded, unexpired action (see liveActionStatus). */
export type LiveStatus = "pending" | "decided" | "missing" | "unreadable";

/**
 * What a reopened conversation shows for a saved action:
 * - its recorded outcome, if there is one;
 * - otherwise, once expired: "unavailable" (no result was recorded);
 * - otherwise the live store decides: still "pending" (executable; the
 *   server enforces everything), already decided without a record
 *   ("unknown": e.g. its record failed -- never executable again), gone
 *   ("unavailable"), or unreadable ("unknown", fail closed).
 */
export function restoredState(
  action: ProposedActionView,
  recorded: Map<string, RestoredActionState>,
  now: number = Date.now(),
  live: LiveStatus = "unreadable",
): RestoredActionState | "pending" {
  const outcome = recorded.get(action.id);
  if (outcome) return outcome;
  if (action.expiresAt <= now) return "unavailable";
  if (live === "pending") return "pending";
  if (live === "missing") return "unavailable";
  return "unknown";
}

/**
 * Live status of the saved actions that have no recorded outcome and haven't
 * expired (read-only, owner-scoped). A store error makes them "unreadable".
 */
export async function liveStatuses(
  redis: EvalClient,
  owner: { orgId: string; userId: string },
  actions: ProposedActionView[],
  recorded: Map<string, RestoredActionState>,
  now: number = Date.now(),
): Promise<Map<string, LiveStatus>> {
  const open = actions.filter((a) => !recorded.has(a.id) && a.expiresAt > now);
  const result = new Map<string, LiveStatus>();
  await Promise.all(
    open.map(async (a) => {
      try {
        result.set(a.id, await liveActionStatus(redis, owner, a.conversationId, a.id));
      } catch {
        result.set(a.id, "unreadable");
      }
    }),
  );
  return result;
}
