import { NextResponse } from "next/server";
import { z } from "zod";
import { jobPayloadJson, jobWillBeRetried } from "@/server/jobs/payload";
import type { Prisma } from "@/generated/prisma/client/client";
import { WorkflowNotificationEmail } from "../../../../../../emails/workflow-notification";
import type { WorkflowStep } from "@/lib/validators/workflows";
import {
  CONTACT_MISSING_ERROR,
  CONTACT_MISSING_TEST_RUN_ERROR,
  CONTACT_NOT_FOUND_ERROR,
  INVALID_RECIPIENT_ERROR_PREFIX,
  isTerminalRunError,
  retryableFailedRunWhere,
} from "@/lib/workflows/run-failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * A claimed-but-never-finished run older than this is treated as abandoned
 * (crashed/killed worker, nothing left to resume it) and becomes eligible
 * for reclaim by the next delivery, rather than staying stuck in RUNNING
 * forever. Comfortably longer than this route's own `maxDuration` (300s) -
 * the platform itself kills any execution before that, so a still-RUNNING
 * row past this threshold cannot be a legitimately in-progress attempt.
 * Mirrors the Stripe webhook ledger's STALE_PROCESSING_MS.
 */
const STALE_RUNNING_MS = 6 * 60_000;

/**
 * Same reasoning as STALE_RUNNING_MS, applied to a single step's CLAIMED
 * WorkflowStepExecution row rather than the whole run: a step realistically
 * completes in a small fraction of the run's own 300s budget, so reusing
 * the run-level threshold is deliberately conservative (never reclaims a
 * step out from under a worker that could plausibly still be active) while
 * still closing the "PR #84 reclaimed the run but a different worker is
 * still mid-step" overlap window - see claimStep().
 */
const STALE_STEP_CLAIM_MS = STALE_RUNNING_MS;

/**
 * A 409 for a claim that is not yet stale: QStash delivers the message again
 * after Retry-After, set to just past the moment the claim becomes
 * reclaimable. QStash's default backoff is documented as about 12 s, 2.5 min
 * and 30 min, but not which retry starts the series; if it starts at 1 s, all
 * three retries land inside the 6-minute window and the message ends in the
 * DLQ with the claim never reclaimed. The margin covers clock differences
 * between the servers that write and read a claim's time.
 */
const RETRY_AFTER_MARGIN_SECONDS = 10;

function retryWhenStale(body: Record<string, unknown>, staleAt: Date): NextResponse {
  const seconds = Math.max(
    1,
    Math.ceil((staleAt.getTime() - Date.now()) / 1000) + RETRY_AFTER_MARGIN_SECONDS,
  );
  return NextResponse.json(body, { status: 409, headers: { "Retry-After": String(seconds) } });
}

const payloadSchema = z.object({
  workflowId: z.string().guid(),
  orgId: z.string().guid(),
  triggerType: z.string(),
  triggerData: z.record(z.string(), z.unknown()),
  runId: z.string().guid().optional(), // resume after wait step
  resumeFromIndex: z.number().int().optional(),
  // Present on every fresh, event-driven trigger (emitWorkflowEvent) -
  // absent for manual/test runs and wait-step resumes, both of which always
  // carry `runId` instead and never reach the claim path below.
  sourceEventKey: z.string().min(1).optional(),
});

type StepResult = { stepId: string; status: "ok" | "skipped" | "failed"; output?: unknown };
type Ctx = { trigger: Record<string, unknown>; vars: Record<string, unknown> };

/**
 * {{trigger.x}} / {{vars.y}} interpolation. `format` lets an ai.generate
 * prompt mark each value as data (see formatWorkflowDataValue).
 */
function interpolate(
  template: string,
  ctx: Ctx,
  format: (path: string, value: string) => string = (_path, value) => value,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
        { trigger: ctx.trigger, vars: ctx.vars } as Record<string, unknown>,
      );
    return format(path, value === undefined || value === null ? "" : String(value));
  });
}

function resolveField(path: string, ctx: Ctx): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      { trigger: ctx.trigger, vars: ctx.vars } as Record<string, unknown>,
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

function isRecordNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2025";
}

type StepClaimResult =
  | { claimed: true; stepExecutionId: string; startedAt: Date }
  | { claimed: false; reason: "succeeded"; output: unknown }
  | { claimed: false; reason: "in_progress"; staleAt: Date };

/**
 * Thrown when a step's completion/failure write loses an optimistic-
 * concurrency race to another worker that reclaimed the same step in the
 * meantime (see claimStep()'s `startedAt` fencing token below). This is not
 * a step failure: the reclaiming worker's own attempt is the one of record,
 * so callers must treat it as "already handled elsewhere," never as a
 * reason to fail the run or overwrite the winner's status.
 */
class StepFencedError extends Error {}

/**
 * Thrown when a step is refused before its side effect runs (e.g. the org is
 * out of AI quota). The step and run end FAILED as usual, but the route
 * answers 200: retrying cannot help, and each retry would notify the
 * creator again.
 */
class WorkflowStepRefusedError extends Error {
  constructor(readonly reason: "ai_quota_exceeded") {
    super(reason);
  }
}

/**
 * A step failure whose message was written here for the workflow's creator
 * (an invalid recipient, a missing contact). Only these messages and
 * refusals are shown; any other error (a provider's, the database's) is
 * described by its name alone, so no internal text reaches a notification,
 * the run record or the response.
 *
 * Throw it only for failures the same input reproduces on every attempt: it
 * ends the job without a QStash retry. A provider or database condition must
 * propagate as its own error so it is retried.
 */
class WorkflowStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStepError";
  }
}

function failureText(err: unknown, fallback: string): string {
  if (err instanceof WorkflowStepRefusedError || err instanceof WorkflowStepError) {
    return err.message;
  }
  return err instanceof Error ? `${fallback} (${err.name})` : fallback;
}

/**
 * Durable, atomic per-(workflowRunId, stepId) claim - closes the crash
 * window PR #84's run-level claim leaves open: a reclaimed FAILED/stale-
 * RUNNING run restarts its step loop from index 0 (see the run-level claim
 * above), so without this a step whose side effect already durably
 * succeeded (email sent, Activity created, AI generation billed) would run
 * again. Mirrors PR #84's own create-first-catch-P2002 run claim exactly,
 * at step granularity: the unique constraint on WorkflowStepExecution
 * (workflowRunId, stepId), not application logic, is what makes this
 * race-proof under two concurrent attempts at the same step - including
 * the case PR #84's run-level reclaim alone does not cover, where a worker
 * whose run just got reclaimed as "stale" is in fact still actively
 * mid-step (see STALE_STEP_CLAIM_MS): that worker already holds this
 * step's own CLAIMED row, so the new claimant's create() collides and, if
 * not yet stale, backs off instead of re-running the step concurrently.
 *
 * The returned `startedAt` is a fencing token, not just a timestamp: a
 * worker whose claim goes stale and gets reclaimed by another delivery
 * (still possible if the first worker is merely slow, not dead) must not be
 * able to complete/fail the step after the fact using its now-superseded
 * claim - completeStep()/failStep() require this exact `startedAt` to still
 * be current before writing, so a superseded worker's write is rejected
 * (and, for DB-local steps, its side effect rolled back with it) rather
 * than silently double-executing or clobbering the reclaiming worker's
 * result.
 */
async function claimStep(
  unscopedPrisma: Prisma.TransactionClient,
  params: { organizationId: string; workflowRunId: string; stepId: string },
): Promise<StepClaimResult> {
  try {
    const created = await unscopedPrisma.workflowStepExecution.create({
      data: {
        organizationId: params.organizationId,
        workflowRunId: params.workflowRunId,
        stepId: params.stepId,
        status: "CLAIMED",
      },
    });
    return { claimed: true, stepExecutionId: created.id, startedAt: created.startedAt };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const existing = await unscopedPrisma.workflowStepExecution.findFirstOrThrow({
      where: { workflowRunId: params.workflowRunId, stepId: params.stepId },
    });
    if (existing.status === "SUCCEEDED") {
      return { claimed: false, reason: "succeeded", output: existing.output };
    }

    const staleSince = new Date(Date.now() - STALE_STEP_CLAIM_MS);
    const isReclaimable = existing.status === "FAILED" || existing.startedAt < staleSince;
    if (!isReclaimable) {
      return {
        claimed: false,
        reason: "in_progress",
        staleAt: new Date(existing.startedAt.getTime() + STALE_STEP_CLAIM_MS),
      };
    }

    // Atomic reclaim: a conditional UPDATE, not read-then-write - same
    // guarantee as the run-level reclaim above.
    const reclaimedStartedAt = new Date();
    const reclaimed = await unscopedPrisma.workflowStepExecution.updateMany({
      where: {
        id: existing.id,
        OR: [{ status: "FAILED" }, { status: "CLAIMED", startedAt: { lt: staleSince } }],
      },
      data: { status: "CLAIMED", error: null, startedAt: reclaimedStartedAt, finishedAt: null },
    });
    if (reclaimed.count === 0) {
      // Another delivery reclaimed it just now: its claim is fresh.
      return {
        claimed: false,
        reason: "in_progress",
        staleAt: new Date(Date.now() + STALE_STEP_CLAIM_MS),
      };
    }
    return { claimed: true, stepExecutionId: existing.id, startedAt: reclaimedStartedAt };
  }
}

/**
 * Whether `userId` is a current member of this organization, which must not
 * be soft-deleted. Checked when a notification is about to be written: the
 * save-time check (upsertWorkflow) can't see a member removed later, and a
 * workflow's creator can leave too.
 */
async function isCurrentMember(
  db: Prisma.TransactionClient,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const member = await db.organizationMember.findFirst({
    where: { organizationId: orgId, userId, organization: { deletedAt: null } },
    select: { id: true },
  });
  return member !== null;
}

/** Step output recorded when a notification was skipped for a non-member. */
const RECIPIENT_NOT_MEMBER = { skipped: "recipient_not_member" } as const;

async function completeStep(
  unscopedPrisma: Prisma.TransactionClient,
  claim: { stepExecutionId: string; startedAt: Date },
  output: unknown,
  externalRef?: string,
): Promise<void> {
  // Fencing guard: only the worker whose claim is still current (its
  // `startedAt` hasn't been overwritten by a later reclaim) may record
  // completion. See claimStep()'s doc comment.
  const written = await unscopedPrisma.workflowStepExecution.updateMany({
    where: { id: claim.stepExecutionId, startedAt: claim.startedAt },
    data: {
      status: "SUCCEEDED",
      output: output === undefined ? undefined : (output as Prisma.InputJsonValue),
      externalRef,
      finishedAt: new Date(),
    },
  });
  if (written.count === 0) throw new StepFencedError();
}

async function failStep(
  unscopedPrisma: Prisma.TransactionClient,
  claim: { stepExecutionId: string; startedAt: Date },
  error: string,
): Promise<void> {
  // Best-effort: the outer run-level catch already persists the run's own
  // FAILED status/error from the same thrown error, so a failure recording
  // this step's own status must never mask or replace that. Also
  // fencing-guarded (see completeStep) so a superseded worker's failure
  // can never overwrite a reclaiming worker's SUCCEEDED/FAILED status, and
  // only a step still CLAIMED is failed: if the step's own transaction
  // committed but the client got an error, the step stays SUCCEEDED and a
  // redelivery skips it instead of repeating its side effect.
  await unscopedPrisma.workflowStepExecution
    .updateMany({
      where: { id: claim.stepExecutionId, startedAt: claim.startedAt, status: "CLAIMED" },
      data: { status: "FAILED", error: error.slice(0, 500), finishedAt: new Date() },
    })
    .catch(() => undefined);
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { verifyJobRequest },
    { unscopedPrisma },
    { enqueue },
    { anthropic },
    { routeModel },
    { sendEmail },
    { recordUsage, getEntitlements },
    { isOrganizationActive, ORGANIZATION_INACTIVE },
    { assertAiQuotaAvailable, AiSpendError },
    { WORKFLOW_DATA_SYSTEM_PROMPT, formatWorkflowDataValue, stripWorkflowDataMarkers },
    { isInternalOnlyWorkflowOrg },
    { internalScopeViolations },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/jobs/queue"),
    import("@/server/integrations/anthropic"),
    import("@/server/ai/router"),
    import("@/server/integrations/resend"),
    import("@/server/services/billing/entitlements"),
    import("@/server/jobs/organization-guard"),
    import("@/server/services/ai-spend"),
    import("@/server/ai/prompts/workflow-data"),
    import("@/server/services/workflows"),
    import("@/lib/workflows/internal-scope"),
  ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(jobPayloadJson(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { workflowId, orgId, triggerData, runId, resumeFromIndex, sourceEventKey } = parsed.data;
  // A FAILED run is reclaimable only if its failure wasn't terminal (see
  // TERMINAL_RUN_ERRORS): a terminal failure was acknowledged with 200 and
  // must not run again when the same message is delivered again. A run with
  // no recorded error (crash) or any other error stays retryable.
  const retryableFailedRun = retryableFailedRunWhere();
  // A retryable failure that a delivery completing the run's steps may take
  // over: one another delivery of this run recorded for a step it failed.
  // The internal-only restriction's step_not_allowed (below) is retryable for
  // a reclaim, but it is an administrative stop, never taken over.
  const takeoverableFailedRun: Prisma.WorkflowRunWhereInput = {
    AND: [retryableFailedRun, { OR: [{ error: null }, { NOT: { error: "step_not_allowed" } }] }],
  };

  // Fail closed rather than silently creating an unprotected duplicate-prone
  // run: every fresh-trigger caller (emitWorkflowEvent) supplies
  // sourceEventKey; only resumes (which always carry runId instead) don't.
  if (!runId && !sourceEventKey) {
    return NextResponse.json(
      { error: "missing sourceEventKey for fresh trigger" },
      { status: 400 },
    );
  }

  // A missing or soft-deleted organization gets no step side effects; a run
  // parked on a wait is left as it was.
  if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);

  const workflow = await unscopedPrisma.workflow.findFirst({
    where: { id: workflowId, organizationId: orgId },
  });
  if (!workflow) return NextResponse.json({ skipped: "workflow inactive or gone" });

  // An internal-only organization (lib/workflows/internal-scope.ts) runs no
  // step outside that scope: checked before any step, for fresh triggers,
  // test runs and resumes alike, so a workflow saved before the restriction
  // was set can't send email, call a model or park on a wait either. A test
  // or resumed run is marked FAILED; nothing is executed.
  if (
    (await isInternalOnlyWorkflowOrg(orgId)) &&
    internalScopeViolations(workflow.trigger, workflow.steps).length > 0
  ) {
    if (runId) {
      await unscopedPrisma.workflowRun.updateMany({
        where: {
          id: runId,
          workflowId,
          organizationId: orgId,
          status: { in: ["WAITING", "RUNNING"] },
        },
        data: { status: "FAILED", error: "step_not_allowed", finishedAt: new Date() },
      });
    }
    return NextResponse.json({ skipped: "step_not_allowed" });
  }

  // Only a manual test run (testWorkflowAction, which always carries runId)
  // may run an inactive workflow. Everything else stops here, including the
  // delayed resume of a run parked on wait.duration: deactivating a workflow
  // must also stop its already-waiting runs, which end CANCELED.
  if (!workflow.isActive && (!runId || parsed.data.triggerType !== "manual")) {
    if (runId) {
      await unscopedPrisma.workflowRun.updateMany({
        where: {
          id: runId,
          workflowId,
          organizationId: orgId,
          status: { in: ["WAITING", "RUNNING"] },
        },
        data: { status: "CANCELED", error: "workflow_deactivated", finishedAt: new Date() },
      });
    }
    return NextResponse.json({ skipped: "workflow inactive or gone" });
  }

  // Plan limits are otherwise only checked when a workflow is activated, so
  // an org that was downgraded or locked read-only afterwards would keep
  // running its active workflows (some triggers, such as public bookings,
  // need no signed-in user). Only fresh triggers are gated here: a resume or
  // manual test run continues a run that was already accepted.
  if (!runId) {
    const entitlements = await getEntitlements(orgId);
    if (entitlements.readOnly || entitlements.activeWorkflows <= 0) {
      return NextResponse.json({ skipped: "plan_not_entitled" });
    }
  }

  // Create, resume, or claim the run record. Resuming (runId set) always
  // proceeds - it's this route's own delayed continuation of a run it
  // already owns. A fresh trigger (no runId) must win an atomic claim on
  // sourceEventKey first: at most one accepted run per source event, per
  // workflow, per org (see WorkflowRun.sourceEventKey's unique constraint).
  // This is a create-first-catch-conflict claim, not check-then-create - the
  // unique constraint, not application logic, is what makes it race-proof
  // under two concurrent deliveries of the same event.
  let run: Prisma.WorkflowRunGetPayload<Record<string, never>>;
  if (runId) {
    // Bind the resumed run to the workflow and org it was loaded for above, so
    // a mismatched payload can never rewrite another tenant's run record.
    // A run that already failed terminally stays failed: a repeated delivery
    // of its message executes nothing and notifies no one again. A finished
    // run (SUCCEEDED or CANCELED) is never reopened, and a resume behind a
    // later wait step that already succeeded (its own resume is scheduled, or
    // has run) is a duplicate: QStash deduplicates resumes only for 10
    // minutes, so this is decided here, from the step ledger.
    // The condition is part of the update itself, so it is atomic.
    const runWhere = { id: runId, workflowId, organizationId: orgId };
    const laterWaitIds = (workflow.steps as unknown as WorkflowStep[])
      .slice(resumeFromIndex ?? 0)
      .filter((s) => s.type === "wait.duration")
      .map((s) => s.id);
    const laterWaitSucceeded: Prisma.WorkflowStepExecutionWhereInput = {
      stepId: { in: laterWaitIds },
      status: "SUCCEEDED",
    };
    try {
      run = await unscopedPrisma.workflowRun.update({
        where: {
          ...runWhere,
          OR: [{ status: { in: ["RUNNING", "WAITING"] } }, retryableFailedRun],
          stepExecutions: { none: laterWaitSucceeded },
        },
        data: { status: "RUNNING" },
      });
    } catch (err) {
      if (!isRecordNotFound(err)) throw err;
      const existing = await unscopedPrisma.workflowRun.findFirst({ where: runWhere });
      if (!existing) return NextResponse.json({ skipped: "run not found for workflow" });
      if (existing.status === "SUCCEEDED" || existing.status === "CANCELED") {
        return NextResponse.json({ skipped: "run_finished" });
      }
      if (existing.status === "FAILED" && isTerminalRunError(existing.error)) {
        return NextResponse.json({ skipped: "terminal_failure" });
      }
      return NextResponse.json({ skipped: "resume_superseded" });
    }
  } else {
    try {
      run = await unscopedPrisma.workflowRun.create({
        data: {
          workflowId,
          organizationId: orgId,
          triggerData: triggerData as Prisma.InputJsonValue,
          status: "RUNNING",
          sourceEventKey,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      // Lost the create to an existing row for this exact source event.
      // SUCCEEDED, a run past its first wait step (resume messages own it),
      // WAITING with its resume scheduled, or RUNNING within STALE_RUNNING_MS,
      // means another delivery already owns or finished this event -
      // acknowledge without reprocessing. Only FAILED, RUNNING past the
      // staleness window (inferred crash - nothing left to resume it), or
      // WAITING with no resume scheduled (below) is reclaimable.
      const existing = await unscopedPrisma.workflowRun.findFirst({
        where: { organizationId: orgId, workflowId, sourceEventKey },
      });
      const staleSince = new Date(Date.now() - STALE_RUNNING_MS);
      const staleStepSince = new Date(Date.now() - STALE_STEP_CLAIM_MS);
      if (existing?.status === "FAILED" && isTerminalRunError(existing.error)) {
        return NextResponse.json({ skipped: "terminal_failure" });
      }
      // This message owns the run only until its first wait step's resume
      // exists: from then on, the run belongs to resume messages (each
      // recovers its own part when redelivered), and a fresh walk would stop
      // at that wait anyway. The ledger shows it: the first wait SUCCEEDED, or
      // any claim on a later step, which only a resume makes (a lost
      // completion write can leave the wait CLAIMED after its resume ran). A
      // run past it is acknowledged, however long it has been RUNNING (a
      // resume keeps the run's first startedAt) or if it failed.
      const runSteps = workflow.steps as unknown as WorkflowStep[];
      const firstWait = runSteps.findIndex((s) => s.type === "wait.duration");
      const firstWaitId = firstWait === -1 ? undefined : runSteps[firstWait]!.id;
      const resumeOwned: Prisma.WorkflowStepExecutionWhereInput = {
        OR: [
          { stepId: firstWaitId, status: "SUCCEEDED" },
          { stepId: { in: runSteps.slice(firstWait + 1).map((s) => s.id) } },
        ],
      };
      if (
        existing &&
        firstWaitId &&
        (await unscopedPrisma.workflowStepExecution.findFirst({
          where: { organizationId: orgId, workflowRunId: existing.id, ...resumeOwned },
          select: { id: true },
        }))
      ) {
        return NextResponse.json({
          skipped: "duplicate_trigger",
          duplicate: existing.status === "SUCCEEDED",
        });
      }
      let reclaimable: Prisma.WorkflowRunWhereInput;
      if (existing?.status === "WAITING") {
        // A WAITING run normally has its resume scheduled: a wait step is
        // marked SUCCEEDED only after its resume is enqueued, and the run's
        // latest step claim is that wait step. If that latest claim is
        // unfinished, the resume may never have been enqueued (the enqueue
        // failed and nothing could be recorded) and nothing else would ever
        // deliver this run again: once that claim is FAILED or stale, the
        // run is reclaimed. Only the latest claim decides: an older
        // unfinished one is left behind by a resume that already moved on.
        // If the resume was enqueued after all (only the completion write was
        // lost), the reclaim enqueues the same resume again under the same
        // deduplicationId, which QStash drops within its 10-minute window.
        //
        // This message owns the run only up to its first wait step: a fresh
        // walk stops at that wait once it has succeeded. A latest claim
        // beyond it was made by a resume message, which recovers it itself
        // (its redelivery reclaims the step), so it is acknowledged here.
        const latestStep = await unscopedPrisma.workflowStepExecution.findFirst({
          where: { organizationId: orgId, workflowRunId: existing.id },
          orderBy: { startedAt: "desc" },
        });
        const latestIndex = latestStep ? runSteps.findIndex((s) => s.id === latestStep.stepId) : -1;
        const ownedByThisMessage =
          latestIndex !== -1 && firstWait !== -1 && latestIndex <= firstWait;
        if (!latestStep || latestStep.status === "SUCCEEDED" || !ownedByThisMessage) {
          return NextResponse.json({ skipped: "duplicate_trigger", duplicate: false });
        }
        if (latestStep.status === "CLAIMED" && latestStep.startedAt >= staleStepSince) {
          return retryWhenStale(
            { error: "run_in_progress" },
            new Date(latestStep.startedAt.getTime() + STALE_STEP_CLAIM_MS),
          );
        }
        // Fenced on the state read here, so a resume that set the run
        // RUNNING meanwhile (or claimed a newer step) is never reclaimed.
        reclaimable = {
          status: "WAITING",
          startedAt: existing.startedAt,
          stepExecutions: {
            some: {
              id: latestStep.id,
              OR: [{ status: "FAILED" }, { status: "CLAIMED", startedAt: { lt: staleStepSince } }],
            },
            none: { startedAt: { gt: latestStep.startedAt } },
          },
        };
      } else {
        const isReclaimable =
          existing?.status === "FAILED" ||
          (existing?.status === "RUNNING" && existing.startedAt < staleSince);
        if (!existing || !isReclaimable) {
          // RUNNING within the window: another delivery is working on it now,
          // or was killed by the platform less than STALE_RUNNING_MS ago. A 2xx
          // here would end this message's retries, so a killed run would never
          // be reclaimed; 409 makes QStash deliver again later, when the run has
          // finished (acknowledged then) or gone stale (reclaimed then).
          if (existing?.status === "RUNNING") {
            return retryWhenStale(
              { error: "run_in_progress" },
              new Date(existing.startedAt.getTime() + STALE_RUNNING_MS),
            );
          }
          return NextResponse.json({
            skipped: "duplicate_trigger",
            duplicate: existing?.status === "SUCCEEDED",
          });
        }
        reclaimable = {
          OR: [retryableFailedRun, { status: "RUNNING", startedAt: { lt: staleSince } }],
          ...(firstWaitId ? { stepExecutions: { none: resumeOwned } } : {}),
        };
      }

      // Atomic reclaim: a conditional UPDATE, not read-then-write. Under two
      // concurrent reclaim attempts, Postgres row-level locking guarantees
      // exactly one `updateMany` matches; the loser's count is 0.
      //
      // stepResults IS reset to [] here - that's safe, not lossy: durable
      // per-step completion now lives in WorkflowStepExecution (unaffected
      // by this reset, keyed by workflowRunId which doesn't change), and
      // the step loop below re-derives `results` from index 0 by consulting
      // that ledger for each step - a SUCCEEDED step is skipped and its
      // cached output re-pushed, never re-executed. Leaving the old
      // stepResults in place instead would double-push an entry for every
      // already-completed step (once from the stale checkpoint, once from
      // the skip logic) without adding any correctness benefit.
      const reclaimed = await unscopedPrisma.workflowRun.updateMany({
        where: { organizationId: orgId, workflowId, sourceEventKey, ...reclaimable },
        data: {
          status: "RUNNING",
          stepResults: [],
          error: null,
          finishedAt: null,
          startedAt: new Date(),
        },
      });
      if (reclaimed.count === 0) {
        // A concurrent delivery reclaimed it first and is running it now.
        return retryWhenStale(
          { error: "run_in_progress" },
          new Date(Date.now() + STALE_RUNNING_MS),
        );
      }
      run = await unscopedPrisma.workflowRun.findFirstOrThrow({
        where: { organizationId: orgId, workflowId, sourceEventKey },
      });
    }
  }

  const steps = workflow.steps as unknown as WorkflowStep[];
  const results: StepResult[] = (run.stepResults as StepResult[]) ?? [];
  // A resume rebuilds the variables from the persisted results. An
  // ai.generate step's text is used as {{vars.<outputVar>}}, so it is restored
  // under that name too, not only under its step id. A live run only ever sets
  // outputVar names, so those win over a step id of the same name, and a later
  // ai.generate overwrites an earlier one with the same outputVar, as live.
  const outputVarByStepId = new Map(
    steps.flatMap((s) => (s.type === "ai.generate" ? [[s.id, s.outputVar] as const] : [])),
  );
  const okResults = results.filter((r) => r.status === "ok" && r.output !== undefined);
  const ctx: Ctx = {
    trigger: triggerData,
    vars: Object.fromEntries([
      ...okResults.map((r) => [r.stepId, r.output] as const),
      ...okResults.flatMap((r) => {
        const outputVar = outputVarByStepId.get(r.stepId);
        return outputVar ? [[outputVar, r.output] as const] : [];
      }),
    ]),
  };

  /**
   * Marks the run SUCCEEDED only while it is unfinished. A duplicate delivery
   * that walked the same steps (each run once, by the step ledger) finds it
   * finished: it neither overwrites the outcome nor counts the run again.
   * WAITING is unfinished too: a delivery that gets here has passed every
   * remaining step, so a WAITING status was left by a stale delivery parking
   * on an earlier wait, and the run did complete. So is a retryable failure
   * recorded by a concurrent delivery of the same resume before this one took
   * over its failed step: every step has now succeeded (an administrative
   * step_not_allowed stop is never taken over). Not fenced on startedAt: a
   * delivery whose step claim went stale and was reclaimed meanwhile counts
   * that step as done elsewhere; that relies on the stale window (6 minutes)
   * outlasting this route's maxDuration (300 s).
   */
  const finish = async (): Promise<boolean> =>
    (
      await unscopedPrisma.workflowRun.updateMany({
        where: {
          id: run.id,
          organizationId: orgId,
          OR: [{ status: { in: ["RUNNING", "WAITING"] } }, takeoverableFailedRun],
        },
        data: {
          stepResults: results as Prisma.InputJsonValue,
          status: "SUCCEEDED",
          finishedAt: new Date(),
          error: null,
        },
      })
    ).count === 1;

  /**
   * The step claim this delivery failed last (each failure is rethrown to
   * the run-level catch below). Its run failure is recorded only while that
   * claim is still this delivery's own.
   */
  let failedClaim: { stepExecutionId: string; startedAt: Date } | null = null;
  const failOwnStep = (claim: { stepExecutionId: string; startedAt: Date }, error: string) => {
    failedClaim = claim;
    return failStep(unscopedPrisma, claim, error);
  };

  /**
   * Parks the run on a wait step, only while it is still this delivery's
   * RUNNING run (its startedAt): a delivery superseded by a reclaim, or one
   * reaching an earlier wait after another finished the run, must not
   * re-park it or schedule another resume. Like finish(), it takes over a
   * failure another delivery of this run recorded for a step this one then
   * completed.
   */
  const park = async (): Promise<boolean> =>
    (
      await unscopedPrisma.workflowRun.updateMany({
        where: {
          id: run.id,
          organizationId: orgId,
          startedAt: run.startedAt,
          OR: [{ status: "RUNNING" }, takeoverableFailedRun],
        },
        data: {
          stepResults: results as Prisma.InputJsonValue,
          status: "WAITING",
          error: null,
          finishedAt: null,
        },
      })
    ).count === 1;

  const persist = () =>
    unscopedPrisma.workflowRun.update({
      where: { id: run.id },
      data: { stepResults: results as Prisma.InputJsonValue },
    });

  try {
    for (let i = resumeFromIndex ?? 0; i < steps.length; i++) {
      const step = steps[i]!;

      switch (step.type) {
        case "condition": {
          // Pure/deterministic given ctx - no side effect, so no claim
          // ledger entry: replaying it is harmless (§Phase 12).
          const actual = resolveField(step.field, ctx);
          const expected = step.value;
          const pass =
            step.comparator === "exists"
              ? actual !== undefined && actual !== null
              : step.comparator === "eq"
                ? actual === expected
                : step.comparator === "neq"
                  ? actual !== expected
                  : step.comparator === "gt"
                    ? Number(actual) > Number(expected)
                    : step.comparator === "lt"
                      ? Number(actual) < Number(expected)
                      : step.comparator === "contains"
                        ? String(actual ?? "")
                            .toLowerCase()
                            .includes(String(expected ?? "").toLowerCase())
                        : false;
          results.push({ stepId: step.id, status: "ok", output: pass });
          if (!pass) {
            // linear model (§17.1): failed condition ends the run successfully
            for (let j = i + 1; j < steps.length; j++) {
              results.push({ stepId: steps[j]!.id, status: "skipped" });
            }
            await finish();
            return NextResponse.json({ ok: true, stoppedAt: step.id });
          }
          break;
        }

        case "ai.generate": {
          const claim = await claimStep(unscopedPrisma, {
            organizationId: orgId,
            workflowRunId: run.id,
            stepId: step.id,
          });
          if (!claim.claimed) {
            if (claim.reason === "succeeded") {
              const text = typeof claim.output === "string" ? claim.output : "";
              ctx.vars[step.outputVar] = text;
              results.push({ stepId: step.id, status: "ok", output: text });
              break;
            }
            return retryWhenStale({ error: "step_in_progress", stepId: step.id }, claim.staleAt);
          }
          try {
            // Checked only for a step this attempt actually claimed: a
            // SUCCEEDED replay above reuses its output and is never re-checked
            // or re-counted.
            try {
              await assertAiQuotaAvailable(orgId);
            } catch (quotaErr) {
              if (quotaErr instanceof AiSpendError) {
                throw new WorkflowStepRefusedError("ai_quota_exceeded");
              }
              throw quotaErr;
            }
            const { model, maxTokens } = routeModel("utility");
            const res = await anthropic.messages.create(
              {
                model,
                max_tokens: maxTokens,
                system: WORKFLOW_DATA_SYSTEM_PROMPT,
                messages: [
                  {
                    role: "user",
                    content: interpolate(step.prompt, ctx, formatWorkflowDataValue),
                  },
                ],
              },
              // Stable across retries of this exact claim (see claimStep) -
              // lets the provider itself dedupe a resend after a crash
              // between the call succeeding and completeStep() persisting.
              { idempotencyKey: claim.stepExecutionId },
            );
            const text = res.content[0]?.type === "text" ? res.content[0].text : "";
            const truncated = stripWorkflowDataMarkers(text).slice(0, 2000);
            ctx.vars[step.outputVar] = truncated;
            let completedHere = true;
            try {
              await completeStep(unscopedPrisma, claim, truncated);
            } catch (completeErr) {
              // Lost the fencing race after the (provider-deduped) call
              // already succeeded - another worker's claim/completion is
              // the one of record. Not a failure: proceed as ok, but leave
              // usage to that worker so the generation is counted once.
              if (!(completeErr instanceof StepFencedError)) throw completeErr;
              completedHere = false;
            }
            results.push({ stepId: step.id, status: "ok", output: truncated });
            if (completedHere) {
              // Best-effort: the step is already SUCCEEDED, so a recording
              // failure must not fail it - that would reclaim it on retry
              // and call the provider again.
              const usage = [
                ["AI_TOKENS_OUT", res.usage.output_tokens, { feature: "workflow", workflowId }],
                [
                  "AI_MESSAGES",
                  1,
                  { feature: "workflow", workflowId, runId: run.id, stepId: step.id },
                ],
              ] as const;
              for (const [metric, quantity, metadata] of usage) {
                await recordUsage(orgId, metric, quantity, metadata).catch((usageErr: unknown) => {
                  console.error("run-workflow: usage recording failed", {
                    orgId,
                    workflowId,
                    runId: run.id,
                    stepId: step.id,
                    metric,
                    errorClass: usageErr instanceof Error ? usageErr.name : typeof usageErr,
                  });
                });
              }
            }
          } catch (stepErr) {
            if (!(stepErr instanceof StepFencedError)) {
              await failOwnStep(claim, failureText(stepErr, "ai.generate failed"));
            }
            throw stepErr;
          }
          break;
        }

        case "email.send": {
          const claim = await claimStep(unscopedPrisma, {
            organizationId: orgId,
            workflowRunId: run.id,
            stepId: step.id,
          });
          if (!claim.claimed) {
            if (claim.reason === "succeeded") {
              results.push({ stepId: step.id, status: "ok" });
              break;
            }
            return retryWhenStale({ error: "step_in_progress", stepId: step.id }, claim.staleAt);
          }
          try {
            const to = interpolate(step.to, ctx);
            if (!to.includes("@"))
              throw new WorkflowStepError(`${INVALID_RECIPIENT_ERROR_PREFIX} "${to}"`);
            const sent = await sendEmail({
              to,
              subject: interpolate(step.subject, ctx),
              react: WorkflowNotificationEmail({
                body: interpolate(step.body, ctx),
                workflowName: workflow.name,
              }),
              // Resend's own Idempotency-Key: dedupes the actual send on the
              // provider side if a retry reuses this same claim (crash
              // between Resend accepting the send and completeStep()
              // persisting it) - see docs/DECISIONS.md for the provider
              // contract and its limits.
              idempotencyKey: claim.stepExecutionId,
            });
            try {
              await completeStep(unscopedPrisma, claim, undefined, sent.id);
            } catch (completeErr) {
              if (!(completeErr instanceof StepFencedError)) throw completeErr;
            }
            results.push({ stepId: step.id, status: "ok" });
          } catch (stepErr) {
            if (!(stepErr instanceof StepFencedError)) {
              await failOwnStep(claim, failureText(stepErr, "email.send failed"));
            }
            throw stepErr;
          }
          break;
        }

        case "crm.create_activity": {
          const claim = await claimStep(unscopedPrisma, {
            organizationId: orgId,
            workflowRunId: run.id,
            stepId: step.id,
          });
          if (!claim.claimed) {
            if (claim.reason === "succeeded") {
              results.push({ stepId: step.id, status: "ok" });
              break;
            }
            return retryWhenStale({ error: "step_in_progress", stepId: step.id }, claim.staleAt);
          }
          try {
            // The contact field can be empty: a manual test run carries no
            // trigger record, and some triggers (deal events) have no
            // contact. Contact ids are canonical UUIDs: anything else is
            // refused here, before a query Postgres would reject with a
            // driver error (22P02) instead of a reason the creator can act on.
            const rawContactId = resolveField(step.contactIdVar, ctx);
            if (rawContactId === undefined || rawContactId === null || rawContactId === "") {
              throw new WorkflowStepError(
                ctx.trigger.test === true ? CONTACT_MISSING_TEST_RUN_ERROR : CONTACT_MISSING_ERROR,
              );
            }
            const contactId = String(rawContactId);
            const contact = UUID_RE.test(contactId)
              ? await unscopedPrisma.contact.findFirst({
                  where: { id: contactId, organizationId: orgId },
                })
              : null;
            if (!contact) throw new WorkflowStepError(CONTACT_NOT_FOUND_ERROR);
            // DB-local side effect: creating the Activity and marking the
            // step SUCCEEDED commit atomically together, so there is no
            // crash window between them at all (unlike email/AI, which
            // call an external API that cannot join this transaction). The
            // fencing-guarded updateMany (see completeStep) is what makes
            // this genuinely exactly-once even against a stale-but-still-
            // alive worker: if another worker reclaimed this step in the
            // meantime, the guard matches zero rows and the throw rolls
            // back the activity.create() in this same transaction too -
            // this worker never durably creates the Activity at all.
            await unscopedPrisma.$transaction(async (tx) => {
              await tx.activity.create({
                data: {
                  organizationId: orgId,
                  contactId,
                  type: step.activityType,
                  subject: interpolate(step.subject, ctx),
                  body: step.body ? interpolate(step.body, ctx) : undefined,
                  metadata: { via: "workflow", workflowId },
                },
              });
              const written = await tx.workflowStepExecution.updateMany({
                where: { id: claim.stepExecutionId, startedAt: claim.startedAt },
                data: { status: "SUCCEEDED", finishedAt: new Date() },
              });
              if (written.count === 0) throw new StepFencedError();
            });
            results.push({ stepId: step.id, status: "ok" });
          } catch (stepErr) {
            if (stepErr instanceof StepFencedError) {
              // Lost the race entirely - our activity.create() above was
              // rolled back with it. Another worker's attempt is the one
              // of record; this step is done, just not by us.
              results.push({ stepId: step.id, status: "ok" });
              break;
            }
            await failOwnStep(claim, failureText(stepErr, "crm.create_activity failed"));
            throw stepErr;
          }
          break;
        }

        case "notify.member": {
          const claim = await claimStep(unscopedPrisma, {
            organizationId: orgId,
            workflowRunId: run.id,
            stepId: step.id,
          });
          if (!claim.claimed) {
            if (claim.reason === "succeeded") {
              const skipped =
                (claim.output as { skipped?: unknown } | null)?.skipped ===
                RECIPIENT_NOT_MEMBER.skipped;
              results.push(
                skipped
                  ? { stepId: step.id, status: "skipped", output: RECIPIENT_NOT_MEMBER }
                  : { stepId: step.id, status: "ok" },
              );
              break;
            }
            return retryWhenStale({ error: "step_in_progress", stepId: step.id }, claim.staleAt);
          }
          try {
            // Same atomic-transaction + fencing treatment as
            // crm.create_activity. Membership is checked in the same
            // transaction as the write: a recipient removed from the org
            // (or an org deleted) since the workflow was saved gets nothing,
            // and the step completes as skipped rather than failing the run.
            const recipientId = step.userId ?? workflow.createdById;
            const delivered = await unscopedPrisma.$transaction(async (tx) => {
              const member = await isCurrentMember(tx, orgId, recipientId);
              if (member) {
                await tx.notification.create({
                  data: {
                    organizationId: orgId,
                    userId: recipientId,
                    type: "workflow.notification",
                    title: interpolate(step.title, ctx),
                    body: step.body ? interpolate(step.body, ctx) : undefined,
                    href: `/workflows/${workflowId}`,
                  },
                });
              }
              const written = await tx.workflowStepExecution.updateMany({
                where: { id: claim.stepExecutionId, startedAt: claim.startedAt },
                data: {
                  status: "SUCCEEDED",
                  ...(member ? {} : { output: RECIPIENT_NOT_MEMBER }),
                  finishedAt: new Date(),
                },
              });
              if (written.count === 0) throw new StepFencedError();
              return member;
            });
            results.push(
              delivered
                ? { stepId: step.id, status: "ok" }
                : { stepId: step.id, status: "skipped", output: RECIPIENT_NOT_MEMBER },
            );
          } catch (stepErr) {
            if (stepErr instanceof StepFencedError) {
              results.push({ stepId: step.id, status: "ok" });
              break;
            }
            await failOwnStep(claim, failureText(stepErr, "notify.member failed"));
            throw stepErr;
          }
          break;
        }

        case "wait.duration": {
          const claim = await claimStep(unscopedPrisma, {
            organizationId: orgId,
            workflowRunId: run.id,
            stepId: step.id,
          });
          if (!claim.claimed) {
            // Unlike the other step types, an already-SUCCEEDED wait means
            // the WAITING persist + resume enqueue already happened for
            // this run - a later delivery reaching this point (e.g. QStash
            // redelivering the original trigger message after the 200
            // response was lost in transit) must stop here rather than
            // fall through and run the *next* steps immediately, which
            // would race the legitimately scheduled resume.
            if (claim.reason === "succeeded") {
              return NextResponse.json({
                ok: true,
                skipped: "duplicate_wait_resume",
                stepId: step.id,
              });
            }
            return retryWhenStale({ error: "step_in_progress", stepId: step.id }, claim.staleAt);
          }
          results.push({ stepId: step.id, status: "ok" });
          if (!(await park())) {
            await failStep(unscopedPrisma, claim, "run superseded before parking");
            // Finished meanwhile: nothing left to schedule. Otherwise another
            // delivery parked or holds the run, and this wait may be the one
            // left to schedule: this message is delivered again shortly, and
            // its redelivery reclaims the failed wait claim and parks.
            const current = await unscopedPrisma.workflowRun.findFirst({
              where: { id: run.id, organizationId: orgId },
              select: { status: true, error: true },
            });
            const finished =
              !current ||
              current.status === "SUCCEEDED" ||
              current.status === "CANCELED" ||
              (current.status === "FAILED" && isTerminalRunError(current.error));
            if (finished) return NextResponse.json({ skipped: "run_superseded" });
            return retryWhenStale({ error: "run_in_progress" }, new Date());
          }
          try {
            await enqueue(
              "run-workflow",
              {
                workflowId,
                orgId,
                triggerType: parsed.data.triggerType,
                triggerData,
                runId: run.id,
                resumeFromIndex: i + 1,
              },
              // One resume per run and wait step: a reclaim that enqueues it
              // again after a lost completion write is dropped by QStash if it
              // comes within the 10-minute deduplication window.
              {
                delaySeconds: step.seconds,
                deduplicationId: `workflow-resume:${run.id}:${step.id}`,
              },
            );
          } catch (enqueueErr) {
            // No resume is scheduled: the step must not stay CLAIMED, or the
            // retry that reclaims this run would find it "in progress" forever.
            await failOwnStep(claim, failureText(enqueueErr, "wait.duration failed"));
            throw enqueueErr;
          }
          try {
            await completeStep(unscopedPrisma, claim, undefined);
          } catch (completeErr) {
            // Lost the fencing race after already enqueueing our own resume
            // - harmless: a duplicate resume converges via the
            // duplicate_wait_resume check above, and another worker's claim
            // is the one of record.
            if (!(completeErr instanceof StepFencedError)) throw completeErr;
          }
          return NextResponse.json({ ok: true, waiting: step.seconds });
        }
      }

      await persist(); // checkpoint after every step (resumable)
    }

    if (!(await finish())) return NextResponse.json({ skipped: "run_superseded" });
    // Best-effort, like the per-step usage: a usage write that fails must not
    // turn a run that succeeded into a failure.
    await recordUsage(orgId, "WORKFLOW_RUNS", 1, { workflowId }).catch((usageErr: unknown) => {
      console.error("run-workflow: usage recording failed", {
        orgId,
        workflowId,
        runId: run.id,
        metric: "WORKFLOW_RUNS",
        errorClass: usageErr instanceof Error ? usageErr.name : typeof usageErr,
      });
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = failureText(err, "step failed").slice(0, 500);
    results.push({ stepId: "error", status: "failed", output: message });
    console.error(
      JSON.stringify({
        event: "workflow_run_failed",
        orgId,
        workflowId,
        runId: run.id,
        name: err instanceof Error ? err.name : "unknown",
      }),
    );
    // Only a creator who is still a member of this (not deleted) org is told,
    // and only once per run: not for an attempt QStash will deliver again.
    // A refusal or a step error (invalid recipient, missing or unknown
    // contact) fails the same way on every attempt, so it ends the job now.
    const terminal = err instanceof WorkflowStepRefusedError || err instanceof WorkflowStepError;
    const finalAttempt = !jobWillBeRetried(request);
    /**
     * Fails this worker's own unfinished run and, if asked, tells the creator,
     * in the caller's transaction. Fenced: only the run this delivery claimed
     * (its startedAt; a stale reclaim gives the run a new one), only while it
     * is RUNNING or WAITING (never over a SUCCEEDED or CANCELED result), and
     * only in this organization. Returns false when there was nothing to fail.
     */
    const recordFailure = async (
      tx: Prisma.TransactionClient,
      error: string,
      notify: boolean,
    ): Promise<boolean> => {
      // Concurrent deliveries of one resume share the run's startedAt, so the
      // run fence alone can't tell them apart. The step this delivery failed
      // decides: if another delivery reclaimed it (a reclaim always writes a
      // new startedAt), that one is completing the run, and this failure is
      // not the run's. Its status doesn't matter: it is FAILED, still CLAIMED
      // if failStep couldn't write, or SUCCEEDED if its own transaction
      // committed before the client got an error. The write changes nothing
      // but takes the step row's lock, so a reclaim arriving meanwhile waits
      // for this transaction instead of crossing it.
      const ownFailedClaim = failedClaim;
      if (ownFailedClaim) {
        const stillOwn = await tx.workflowStepExecution.updateMany({
          where: {
            id: ownFailedClaim.stepExecutionId,
            organizationId: orgId,
            startedAt: ownFailedClaim.startedAt,
          },
          data: { startedAt: ownFailedClaim.startedAt },
        });
        if (stillOwn.count === 0) return false;
      }
      const failed = await tx.workflowRun.updateMany({
        where: {
          id: run.id,
          organizationId: orgId,
          startedAt: run.startedAt,
          status: { in: ["RUNNING", "WAITING"] },
        },
        data: {
          stepResults: results as Prisma.InputJsonValue,
          status: "FAILED",
          finishedAt: new Date(),
          error,
        },
      });
      if (failed.count === 0) return false;
      if (notify && (await isCurrentMember(tx, orgId, workflow.createdById))) {
        await tx.notification.create({
          data: {
            organizationId: orgId,
            userId: workflow.createdById,
            type: "workflow.failed",
            title: workflow.name,
            body: message,
            href: `/workflows/${workflowId}`,
          },
        });
      }
      return true;
    };
    // The FAILED state and the creator's notification commit together. A
    // terminal failure is never run again (TERMINAL_RUN_ERRORS) and a final
    // attempt has no retry left, so a notification written separately after
    // the run had failed, and lost to an error, would never be written.
    let recorded: boolean;
    try {
      recorded = await unscopedPrisma.$transaction((tx) =>
        recordFailure(tx, message, terminal || finalAttempt),
      );
    } catch (recordErr) {
      // Normally nothing committed. If the commit did succeed and only the
      // reply was lost, the run is FAILED now and the fenced write below
      // matches nothing, so nothing is written or notified twice. Otherwise:
      // - a retry is coming: leave a retryable failure (not a terminal text)
      //   so the redelivery runs the step again and records both;
      // - the final attempt: nothing will deliver again, so tell the creator
      //   now, together with the retryable failure.
      // If this write fails too (the database is unreachable), the run keeps
      // its status and the step its claim. The redelivery of this message
      // recovers it once that claim is stale, whether the run is RUNNING or
      // WAITING; until then it answers 409 with Retry-After. Limit: the
      // database must be back within QStash's retries, or the message ends in
      // the DLQ (replaying it from there recovers the run the same way).
      await unscopedPrisma
        .$transaction((tx) =>
          recordFailure(tx, failureText(recordErr, "failure not recorded"), finalAttempt),
        )
        .catch(() => undefined);
      return NextResponse.json({ error: message }, { status: 500 });
    }
    if (!recorded) {
      // Another delivery reclaimed this run (or it finished meanwhile): its
      // outcome stands, and this delivery has nothing left to do.
      return NextResponse.json({ skipped: "run_superseded" });
    }
    if (err instanceof WorkflowStepRefusedError) {
      // Deliberate refusal, not a transient error: a retry would only fail
      // again and notify the creator again.
      return NextResponse.json({ error: message, refused: err.reason });
    }
    if (err instanceof WorkflowStepError) {
      // Deterministic: the same input fails the same way, so a retry would
      // only repeat the failure. The run stays FAILED with its reason.
      return NextResponse.json({ error: message, failed: true });
    }
    // QStash retries (3x) then DLQ (§17.2)
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
