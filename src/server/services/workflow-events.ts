import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { enqueue } from "@/server/jobs/queue";

export type WorkflowTriggerType =
  | "contact.created"
  | "deal.stage_changed"
  | "deal.won"
  | "call.completed"
  | "booking.created"
  | "booking.canceled"
  | "booking.rescheduled"
  | "schedule.cron"
  | "manual";

/**
 * Emits a domain event: every active workflow with a matching trigger gets
 * a queued run (§17.2). Fire-and-forget from the caller's perspective.
 */
export async function emitWorkflowEvent(
  orgId: string,
  type: WorkflowTriggerType,
  data: Record<string, unknown>,
): Promise<void> {
  const workflows = await unscopedPrisma.workflow.findMany({
    where: {
      organizationId: orgId,
      isActive: true,
      trigger: { path: ["type"], equals: type },
    },
    select: { id: true },
  });

  await Promise.all(
    workflows.map((w) =>
      enqueue("run-workflow", { workflowId: w.id, orgId, triggerType: type, triggerData: data }),
    ),
  );
}
