import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb } from "@/server/db/tenant";
import { WorkflowBuilder } from "@/components/workflows/workflow-builder";
import type { WorkflowStep, WorkflowTrigger } from "@/lib/validators/workflows";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const ctx = await requirePermission("workflows:manage");

  if (workflowId === "new") return <WorkflowBuilder />;

  const db = tenantDb(ctx.orgId);
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
