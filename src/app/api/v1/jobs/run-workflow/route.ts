import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { WorkflowNotificationEmail } from "../../../../../../emails/workflow-notification";
import type { WorkflowStep } from "@/lib/validators/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const payloadSchema = z.object({
  workflowId: z.string().uuid(),
  orgId: z.string().uuid(),
  triggerType: z.string(),
  triggerData: z.record(z.unknown()),
  runId: z.string().uuid().optional(), // resume after wait step
  resumeFromIndex: z.number().int().optional(),
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
  const { workflowId, orgId, triggerData, runId, resumeFromIndex } = parsed.data;

  const workflow = await unscopedPrisma.workflow.findFirst({
    where: { id: workflowId, organizationId: orgId },
  });
  if (!workflow || (!workflow.isActive && !runId)) {
    return NextResponse.json({ skipped: "workflow inactive or gone" });
  }

  // Create or resume the run record (resumable across wait steps, §17.2)
  const run = runId
    ? await unscopedPrisma.workflowRun.update({
        where: { id: runId },
        data: { status: "RUNNING" },
      })
    : await unscopedPrisma.workflowRun.create({
        data: {
          workflowId,
          organizationId: orgId,
          triggerData: triggerData as Prisma.InputJsonValue,
          status: "RUNNING",
        },
      });

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
