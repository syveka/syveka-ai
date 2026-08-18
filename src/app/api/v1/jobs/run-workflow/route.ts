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
      const isUniqueViolation =
        typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
      if (!isUniqueViolation) throw err;

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
          const { model, maxTokens } = routeModel("utility");
          const res = await anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: interpolate(step.prompt, ctx) }],
          });
          const text = res.content[0]?.type === "text" ? res.content[0].text : "";
          ctx.vars[step.outputVar] = text;
          results.push({ stepId: step.id, status: "ok", output: text.slice(0, 2000) });
          await recordUsage(orgId, "AI_TOKENS_OUT", res.usage.output_tokens, {
            feature: "workflow",
            workflowId,
          });
          break;
        }

        case "email.send": {
          const to = interpolate(step.to, ctx);
          if (!to.includes("@")) throw new Error(`email.send: invalid recipient "${to}"`);
          await sendEmail({
            to,
            subject: interpolate(step.subject, ctx),
            react: WorkflowNotificationEmail({
              body: interpolate(step.body, ctx),
              workflowName: workflow.name,
            }),
          });
          results.push({ stepId: step.id, status: "ok" });
          break;
        }

        case "crm.create_activity": {
          const contactId = String(resolveField(step.contactIdVar, ctx) ?? "");
          const contact = await unscopedPrisma.contact.findFirst({
            where: { id: contactId, organizationId: orgId },
          });
          if (!contact) throw new Error("crm.create_activity: contact not found");
          await unscopedPrisma.activity.create({
            data: {
              organizationId: orgId,
              contactId,
              type: step.activityType,
              subject: interpolate(step.subject, ctx),
              body: step.body ? interpolate(step.body, ctx) : undefined,
              metadata: { via: "workflow", workflowId },
            },
          });
          results.push({ stepId: step.id, status: "ok" });
          break;
        }

        case "notify.member": {
          await unscopedPrisma.notification.create({
            data: {
              organizationId: orgId,
              userId: step.userId ?? workflow.createdById,
              type: "workflow.notification",
              title: interpolate(step.title, ctx),
              body: step.body ? interpolate(step.body, ctx) : undefined,
              href: `/workflows/${workflowId}`,
            },
          });
          results.push({ stepId: step.id, status: "ok" });
          break;
        }

        case "wait.duration": {
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
