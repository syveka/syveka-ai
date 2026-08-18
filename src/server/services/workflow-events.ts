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
 *
 * `sourceEventId` is the caller's best stable identity for *this specific
 * occurrence* of the event - required, not optional, so a future call site
 * can't silently skip trigger-level dedup the way the original one did (P1:
 * a redelivered/retried/duplicated source event previously created a second
 * WorkflowRun and re-executed every side effect). It becomes each matched
 * workflow's `sourceEventKey` (see run-workflow/route.ts's atomic claim),
 * scoped per workflow so N workflows subscribed to the same event each still
 * run exactly once. Must be:
 *   - stable across retries of the same underlying occurrence (so a
 *     redelivery collides with the first attempt's claim), and
 *   - distinct across genuinely different occurrences on the same entity
 *     (so e.g. a second, later booking reschedule is never suppressed by
 *     the first).
 * Where the source has no natural id of its own (deal transitions have no
 * external event id), derive one from trusted, pre-mutation server state
 * rather than inventing a weak/entity-only key - see moveDeal's call sites.
 */
export async function emitWorkflowEvent(
  orgId: string,
  type: WorkflowTriggerType,
  data: Record<string, unknown>,
  sourceEventId: string,
): Promise<void> {
  const workflows = await unscopedPrisma.workflow.findMany({
    where: {
      organizationId: orgId,
      isActive: true,
      trigger: { path: ["type"], equals: type },
    },
    select: { id: true },
  });

  const sourceEventKey = `${type}:${sourceEventId}`;
  await Promise.all(
    workflows.map((w) =>
      enqueue("run-workflow", {
        workflowId: w.id,
        orgId,
        triggerType: type,
        triggerData: data,
        sourceEventKey,
      }),
    ),
  );
}
