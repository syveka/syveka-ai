-- Step-level idempotency for run-workflow (P1, follow-up to
-- 20260818000000_workflow_run_source_event_key): a reclaimed FAILED or
-- stale-RUNNING WorkflowRun restarts its step loop from index 0, so a step
-- whose side effect (email sent, Activity created, notification created,
-- AI generation billed) already durably succeeded before a crash would run
-- again. workflow_step_executions is a durable, atomic per-(run, step)
-- claim - see claimStep()/completeStep()/failStep() in
-- src/app/api/v1/jobs/run-workflow/route.ts. `output` caches the step's
-- result so a skipped, already-SUCCEEDED step can still feed later steps'
-- interpolation without re-executing.
CREATE TYPE "StepExecutionStatus" AS ENUM ('CLAIMED', 'SUCCEEDED', 'FAILED');

CREATE TABLE IF NOT EXISTS "workflow_step_executions" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  UUID NOT NULL,
  "workflow_run_id"  UUID NOT NULL,
  "step_id"          TEXT NOT NULL,
  "status"           "StepExecutionStatus" NOT NULL DEFAULT 'CLAIMED',
  "output"           JSONB,
  "external_ref"     TEXT,
  "error"            TEXT,
  "started_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"      TIMESTAMP(3),
  CONSTRAINT "workflow_step_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_step_executions_workflow_run_id_step_id_key"
  ON "workflow_step_executions"("workflow_run_id", "step_id");
CREATE INDEX IF NOT EXISTS "workflow_step_executions_organization_id_started_at_idx"
  ON "workflow_step_executions"("organization_id", "started_at");

ALTER TABLE "workflow_step_executions"
  ADD CONSTRAINT "workflow_step_executions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_step_executions"
  ADD CONSTRAINT "workflow_step_executions_workflow_run_id_fkey"
  FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same shape as workflow_runs_select (its parent table): tenant members can
-- view their own org's step-execution records; all writes go through the
-- service-role Prisma connection (unscopedPrisma), never a client policy.
ALTER TABLE "workflow_step_executions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_step_executions_select" ON "workflow_step_executions"
  FOR SELECT TO authenticated
  USING (organization_id = auth_org_id());
