-- Trigger-level idempotency for workflow runs (P1): the run-workflow job
-- previously created a new WorkflowRun unconditionally for every delivery,
-- so a retried/redelivered/duplicated source event could execute the same
-- workflow (and its side effects) more than once. source_event_key lets the
-- job route make an atomic create-or-reclaim claim per (organization_id,
-- workflow_id, source_event_key) - see
-- src/app/api/v1/jobs/run-workflow/route.ts.
--
-- Nullable and additive: null for manual/test runs (created directly with a
-- runId, never through the claim path) and for pre-existing rows. Postgres
-- treats distinct NULLs as non-conflicting in a unique index, so neither of
-- those is affected by the new constraint.
ALTER TABLE "workflow_runs" ADD COLUMN "source_event_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_organization_id_workflow_id_source_event_key_key"
  ON "workflow_runs"("organization_id", "workflow_id", "source_event_key");
