import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { WorkflowNotificationEmail } from "../../../../../../emails/workflow-notification";
import type { WorkflowStep } from "@/lib/validators/workflows";

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

const payloadSchema = z.object({
  workflowId: z.string().uuid(),
  orgId: z.string().uuid(),
  triggerType: z.string(),
  triggerData: z.record(z.unknown()),
  runId: z.string().uuid().optional(), // resume after wait step
  resumeFromIndex: z.number().int().optional(),
  // Present on every fresh, event-driven trigger (emitWorkflowEvent) -
  // absent for manual/test runs and wait-step resumes, both of which always
  // carry `runId` instead and never reach the claim path below.
  sourceEventKey: z.string().min(1).optional(),
});

type StepResult = { stepId: string; status: "ok" | "skipped" | "failed"; output?: unknown };
type Ctx = { trigger: Record<string, unknown>; vars: Record<string, unknown> };

/** {{trigger.x}} / {{vars.y}} interpolation. */
function interpolate(template: string, ctx: Ctx): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
        { trigger: ctx.trigger, vars: ctx.vars } as Record<string, unknown>,
      );
    return value === undefined || value === null ? "" : String(value);
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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

type StepClaimResult =
  | { claimed: true; stepExecutionId: string; startedAt: Date }
  | { claimed: false; reason: "succeeded"; output: unknown }
  | { claimed: false; reason: "in_progress" };

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
      return { claimed: false, reason: "in_progress" };
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
      return { claimed: false, reason: "in_progress" };
    }
    return { claimed: true, stepExecutionId: existing.id, startedAt: reclaimedStartedAt };
  }
}

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
  // can never overwrite a reclaiming worker's SUCCEEDED/FAILED status.
  await unscopedPrisma.workflowStepExecution
    .updateMany({
      where: { id: claim.stepExecutionId, startedAt: claim.startedAt },
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
    { recordUsage },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/jobs/queue"),
    import("@/server/integrations/anthropic"),
    import("@/server/ai/router"),
    import("@/server/integrations/resend"),
    import("@/server/services/billing/entitlements"),
  ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { workflowId, orgId, triggerData, runId, resumeFromIndex, sourceEventKey } = parsed.data;

  // Fail closed rather than silently creating an unprotected duplicate-prone
  // run: every fresh-trigger caller (emitWorkflowEvent) supplies
  // sourceEventKey; only resumes (which always carry runId instead) don't.
  if (!runId && !sourceEventKey) {
    return NextResponse.json(
      { error: "missing sourceEventKey for fresh trigger" },
      { status: 400 },
    );
  }

  const workflow = await unscopedPrisma.workflow.findFirst({
    where: { id: workflowId, organizationId: orgId },
  });
  if (!workflow || (!workflow.isActive && !runId)) {
    return NextResponse.json({ skipped: "workflow inactive or gone" });
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
    run = await unscopedPrisma.workflowRun.update({
      where: { id: runId },
      data: { status: "RUNNING" },
    });
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
      // SUCCEEDED/WAITING, or RUNNING within STALE_RUNNING_MS, means another
      // delivery already owns or finished this event - acknowledge without
      // reprocessing. Only FAILED, or RUNNING past the staleness window
      // (inferred crash - nothing left to resume it), is reclaimable.
      const existing = await unscopedPrisma.workflowRun.findFirst({
        where: { organizationId: orgId, workflowId, sourceEventKey },
      });
      const staleSince = new Date(Date.now() - STALE_RUNNING_MS);
      const isReclaimable =
        existing?.status === "FAILED" ||
        (existing?.status === "RUNNING" && existing.startedAt < staleSince);
      if (!existing || !isReclaimable) {
        return NextResponse.json({
          skipped: "duplicate_trigger",
          duplicate: existing?.status === "SUCCEEDED",
        });
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
        where: {
          organizationId: orgId,
          workflowId,
          sourceEventKey,
          OR: [{ status: "FAILED" }, { status: "RUNNING", startedAt: { lt: staleSince } }],
        },
        data: {
          status: "RUNNING",
          stepResults: [],
          error: null,
          finishedAt: null,
          startedAt: new Date(),
        },
      });
      if (reclaimed.count === 0) {
        return NextResponse.json({ skipped: "duplicate_trigger", duplicate: false });
      }
      run = await unscopedPrisma.workflowRun.findFirstOrThrow({
        where: { organizationId: orgId, workflowId, sourceEventKey },
      });
    }
  }

  const steps = workflow.steps as unknown as WorkflowStep[];
  const results: StepResult[] = (run.stepResults as StepResult[]) ?? [];
  const ctx: Ctx = {
    trigger: triggerData,
    vars: Object.fromEntries(
      results
        .filter((r) => r.status === "ok" && r.output !== undefined)
        .map((r) => [r.stepId, r.output]),
    ),
  };

  const persist = (status?: "SUCCEEDED" | "FAILED" | "WAITING", error?: string) =>
    unscopedPrisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stepResults: results as Prisma.InputJsonValue,
        ...(status ? { status, ...(status !== "WAITING" ? { finishedAt: new Date() } : {}) } : {}),
        ...(error ? { error } : {}),
      },
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
            await persist("SUCCEEDED");
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
            return NextResponse.json({ ok: true, skipped: "step_in_progress", stepId: step.id });
          }
          try {
            const { model, maxTokens } = routeModel("utility");
            const res = await anthropic.messages.create(
              {
                model,
                max_tokens: maxTokens,
                messages: [{ role: "user", content: interpolate(step.prompt, ctx) }],
              },
              // Stable across retries of this exact claim (see claimStep) -
              // lets the provider itself dedupe a resend after a crash
              // between the call succeeding and completeStep() persisting.
              { idempotencyKey: claim.stepExecutionId },
            );
            const text = res.content[0]?.type === "text" ? res.content[0].text : "";
            const truncated = text.slice(0, 2000);
            ctx.vars[step.outputVar] = truncated;
            try {
              await completeStep(unscopedPrisma, claim, truncated);
            } catch (completeErr) {
              // Lost the fencing race after the (provider-deduped) call
              // already succeeded - another worker's claim/completion is
              // the one of record. Not a failure: proceed as ok.
              if (!(completeErr instanceof StepFencedError)) throw completeErr;
            }
            results.push({ stepId: step.id, status: "ok", output: truncated });
            await recordUsage(orgId, "AI_TOKENS_OUT", res.usage.output_tokens, {
              feature: "workflow",
              workflowId,
            });
          } catch (stepErr) {
            if (!(stepErr instanceof StepFencedError)) {
              await failStep(
                unscopedPrisma,
                claim,
                stepErr instanceof Error ? stepErr.message : "ai.generate failed",
              );
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
            return NextResponse.json({ ok: true, skipped: "step_in_progress", stepId: step.id });
          }
          try {
            const to = interpolate(step.to, ctx);
            if (!to.includes("@")) throw new Error(`email.send: invalid recipient "${to}"`);
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
              await failStep(
                unscopedPrisma,
                claim,
                stepErr instanceof Error ? stepErr.message : "email.send failed",
              );
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
            return NextResponse.json({ ok: true, skipped: "step_in_progress", stepId: step.id });
          }
          try {
            const contactId = String(resolveField(step.contactIdVar, ctx) ?? "");
            const contact = await unscopedPrisma.contact.findFirst({
              where: { id: contactId, organizationId: orgId },
            });
            if (!contact) throw new Error("crm.create_activity: contact not found");
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
            await failStep(
              unscopedPrisma,
              claim,
              stepErr instanceof Error ? stepErr.message : "crm.create_activity failed",
            );
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
              results.push({ stepId: step.id, status: "ok" });
              break;
            }
            return NextResponse.json({ ok: true, skipped: "step_in_progress", stepId: step.id });
          }
          try {
            // Same atomic-transaction + fencing treatment as
            // crm.create_activity.
            await unscopedPrisma.$transaction(async (tx) => {
              await tx.notification.create({
                data: {
                  organizationId: orgId,
                  userId: step.userId ?? workflow.createdById,
                  type: "workflow.notification",
                  title: interpolate(step.title, ctx),
                  body: step.body ? interpolate(step.body, ctx) : undefined,
                  href: `/workflows/${workflowId}`,
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
              results.push({ stepId: step.id, status: "ok" });
              break;
            }
            await failStep(
              unscopedPrisma,
              claim,
              stepErr instanceof Error ? stepErr.message : "notify.member failed",
            );
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
            return NextResponse.json({
              ok: true,
              skipped: claim.reason === "succeeded" ? "duplicate_wait_resume" : "step_in_progress",
              stepId: step.id,
            });
          }
          results.push({ stepId: step.id, status: "ok" });
          await persist("WAITING");
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
            { delaySeconds: step.seconds },
          );
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

    await persist("SUCCEEDED");
    await recordUsage(orgId, "WORKFLOW_RUNS", 1, { workflowId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "step failed";
    results.push({ stepId: "error", status: "failed", output: message });
    await persist("FAILED", message);
    await unscopedPrisma.notification.create({
      data: {
        organizationId: orgId,
        userId: workflow.createdById,
        type: "workflow.failed",
        title: workflow.name,
        body: message,
        href: `/workflows/${workflowId}`,
      },
    });
    // QStash retries (3x) then DLQ (§17.2)
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
