/**
 * Why a workflow cannot be activated right now, for display only. The server
 * still enforces every limit in setWorkflowActive/assertWithinLimit and
 * testWorkflowAction; this only lets the UI explain the reason up front,
 * before someone invests in building a workflow they cannot switch on.
 *
 * - `not_included`: the plan includes no active workflows (e.g. FREE).
 * - `read_only`: the workspace is read-only (subscription past due).
 * - `limit_reached`: every active-workflow slot in the plan is in use.
 */
export type WorkflowActivationBlock = "not_included" | "read_only" | "limit_reached";

export function workflowActivationBlock(
  entitlements: { readOnly: boolean; activeWorkflows: number },
  activeCount: number,
): WorkflowActivationBlock | null {
  if (entitlements.readOnly) return "read_only";
  if (entitlements.activeWorkflows <= 0) return "not_included";
  if (activeCount >= entitlements.activeWorkflows) return "limit_reached";
  return null;
}

/** Test runs need a plan with workflows and a writable workspace (testWorkflowAction). */
export function blocksTestRun(block: WorkflowActivationBlock | null): boolean {
  return block === "not_included" || block === "read_only";
}

/** Trigger types the builder offers; each has a `workflows.triggers.*` label. */
export const TRIGGER_TYPES = [
  "contact.created",
  "deal.stage_changed",
  "deal.won",
  "call.completed",
  "booking.created",
  "booking.canceled",
  "booking.rescheduled",
  "manual",
] as const;

export type KnownTriggerType = (typeof TRIGGER_TYPES)[number];

export function isKnownTriggerType(value: unknown): value is KnownTriggerType {
  return typeof value === "string" && (TRIGGER_TYPES as readonly string[]).includes(value);
}
