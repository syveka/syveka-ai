export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant";
import { getViewerTimeZone } from "@/server/services/viewer-time-zone";
import { getWorkflowActivation } from "@/server/services/workflow-activation";
import { WorkflowBuilder } from "@/components/workflows/workflow-builder";
import type { WorkflowStep, WorkflowTrigger } from "@/lib/validators/workflows";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const ctx = await requirePermission("workflows:manage");
  const db = tenantDb(ctx.orgId);

  const [activeCount, timeZone] = await Promise.all([
    db.workflow.count({ where: { isActive: true } }),
    getViewerTimeZone(ctx.userId),
  ]);
  const activation = await getWorkflowActivation(ctx.orgId, activeCount);
  const planProps = {
    activation,
    timeZone,
    canViewPlans: can(ctx.role, "billing:view"),
  };

  if (workflowId === "new") return <WorkflowBuilder {...planProps} />;

  const workflow = await db.workflow.findFirst({
    where: { id: workflowId },
    include: {
      runs: {
        orderBy: { startedAt: "desc" },
        take: 20,
        select: { id: true, status: true, startedAt: true, error: true },
      },
    },
  });
  if (!workflow) notFound();

  return (
    <WorkflowBuilder
      {...planProps}
      initial={{
        id: workflow.id,
        name: workflow.name,
        description: workflow.description ?? "",
        trigger: workflow.trigger as WorkflowTrigger,
        steps: workflow.steps as WorkflowStep[],
        isActive: workflow.isActive,
        runs: workflow.runs.map((r) => ({
          id: r.id,
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          error: r.error,
        })),
      }}
    />
  );
}
