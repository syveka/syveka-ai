import "server-only";

import { getEntitlements } from "@/server/services/billing/entitlements";
import { workflowActivationBlock, type WorkflowActivationBlock } from "@/lib/workflows/activation";

/**
 * The plan's workflow activation state for the workflows list and editor, so
 * they can explain up front why activation is unavailable. Display only: the
 * server actions keep enforcing entitlements on every activation and test run.
 * If entitlements cannot be read, no notice is shown (the server action still
 * refuses and the UI then reports its error).
 */
export async function getWorkflowActivation(
  orgId: string,
  activeCount: number,
): Promise<{ block: WorkflowActivationBlock | null; limit: number }> {
  try {
    const entitlements = await getEntitlements(orgId);
    return {
      block: workflowActivationBlock(entitlements, activeCount),
      limit: entitlements.activeWorkflows,
    };
  } catch (error) {
    // Name only: never surface internal error detail.
    console.warn("workflow activation state unavailable", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { block: null, limit: 0 };
  }
}
