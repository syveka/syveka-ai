import { beforeEach, describe, expect, it, vi } from "vitest";

class FakePrismaKnownError extends Error {
  code: string;
  constructor(code: string) {
    super(`Prisma error ${code}`);
    this.code = code;
  }
}

/**
 * A minimal in-memory stand-in for the workflow_step_executions /
 * workflow_runs tables, enforcing the same uniqueness/state-transition
 * rules as the real Postgres schema (see prisma/schema.prisma and
 * tests/integration/run-workflow-step-fencing.mjs for the real-DB proof of
 * the fencing invariant specifically). Used so multi-delivery crash/retry
 * scenarios can be expressed as "call POST twice against shared state"
 * instead of hand-sequencing dozens of one-off mock return values.
 */
function createFakeDb() {
  type Run = {
    id: string;
    workflowId: string;
    organizationId: string;
    status: string;
    triggerData: unknown;
    stepResults: unknown;
    sourceEventKey: string | null;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  };
  type StepExec = {
    id: string;
    organizationId: string;
    workflowRunId: string;
    stepId: string;
    status: string;
    output: unknown;
    externalRef: string | null;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  };

  const runs = new Map<string, Run>();
  const stepExecs = new Map<string, StepExec>();
  // zod validates runId as a UUID, so fake ids must look like one too.
  let seq = 0;
  const nextId = () => {
    seq += 1;
    const hex = seq.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  };

  return {
    runs,
    stepExecs,
    workflow: {
      findFirst: vi.fn(),
    },
    workflowRun: {
      create: vi.fn(async ({ data }: { data: Partial<Run> }) => {
        if (data.sourceEventKey != null) {
          for (const r of runs.values()) {
            if (
              r.organizationId === data.organizationId &&
              r.workflowId === data.workflowId &&
              r.sourceEventKey === data.sourceEventKey
            ) {
              throw new FakePrismaKnownError("P2002");
            }
          }
        }
        const run: Run = {
          id: nextId(),
          workflowId: data.workflowId!,
          organizationId: data.organizationId!,
          status: "RUNNING",
          triggerData: data.triggerData ?? {},
          stepResults: [],
          sourceEventKey: data.sourceEventKey ?? null,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
        };
        runs.set(run.id, run);
        return run;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Run> }) => {
        const run = runs.get(where.id)!;
        Object.assign(run, data);
        return run;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            organizationId: string;
            workflowId: string;
            sourceEventKey: string | null;
            OR: Array<Record<string, unknown>>;
          };
          data: Partial<Run>;
        }) => {
          let count = 0;
          for (const r of runs.values()) {
            if (
              r.organizationId !== where.organizationId ||
              r.workflowId !== where.workflowId ||
              r.sourceEventKey !== where.sourceEventKey
            ) {
              continue;
            }
            const matches = where.OR.some((cond) => {
              if (cond.status === "FAILED") return r.status === "FAILED";
              if (
                cond.status === "RUNNING" &&
                typeof cond.startedAt === "object" &&
                cond.startedAt !== null
              ) {
                const lt = (cond.startedAt as { lt: Date }).lt;
                return r.status === "RUNNING" && r.startedAt < lt;
              }
              return false;
            });
            if (matches) {
              Object.assign(r, data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; workflowId: string; sourceEventKey: string | null };
        }) => {
          for (const r of runs.values()) {
            if (
              r.organizationId === where.organizationId &&
              r.workflowId === where.workflowId &&
              r.sourceEventKey === where.sourceEventKey
            ) {
              return r;
            }
          }
          return null;
        },
      ),
      findFirstOrThrow: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; workflowId: string; sourceEventKey: string | null };
        }) => {
          for (const r of runs.values()) {
            if (
              r.organizationId === where.organizationId &&
              r.workflowId === where.workflowId &&
              r.sourceEventKey === where.sourceEventKey
            ) {
              return r;
            }
          }
          throw new Error("not found");
        },
      ),
    },
    workflowStepExecution: {
      create: vi.fn(async ({ data }: { data: Partial<StepExec> }) => {
        for (const s of stepExecs.values()) {
          if (s.workflowRunId === data.workflowRunId && s.stepId === data.stepId) {
            throw new FakePrismaKnownError("P2002");
          }
        }
        const stepExec: StepExec = {
          id: nextId(),
          organizationId: data.organizationId!,
          workflowRunId: data.workflowRunId!,
          stepId: data.stepId!,
          status: "CLAIMED",
          output: null,
          externalRef: null,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
        };
        stepExecs.set(stepExec.id, stepExec);
        return stepExec;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<StepExec> }) => {
        const s = stepExecs.get(where.id)!;
        Object.assign(s, data);
        return s;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; OR?: Array<Record<string, unknown>>; startedAt?: Date };
          data: Partial<StepExec>;
        }) => {
          const s = stepExecs.get(where.id);
          if (!s) return { count: 0 };
          // Two call shapes hit this mock: the reclaim guard (OR of stale
          // conditions, from claimStep) and the fencing guard (plain
          // startedAt equality, from completeStep/failStep) - both must be
          // honored for the fencing fix's control flow to be exercised.
          let matches: boolean;
          if (where.OR) {
            matches = where.OR.some((cond) => {
              if (cond.status === "FAILED") return s.status === "FAILED";
              if (cond.status === "CLAIMED" && typeof cond.startedAt === "object") {
                const lt = (cond.startedAt as { lt: Date }).lt;
                return s.status === "CLAIMED" && s.startedAt < lt;
              }
              return false;
            });
          } else {
            matches = s.startedAt.getTime() === where.startedAt!.getTime();
          }
          if (!matches) return { count: 0 };
          Object.assign(s, data);
          return { count: 1 };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { workflowRunId: string; stepId: string } }) => {
        for (const s of stepExecs.values()) {
          if (s.workflowRunId === where.workflowRunId && s.stepId === where.stepId) return s;
        }
        return null;
      }),
      findFirstOrThrow: vi.fn(
        async ({ where }: { where: { workflowRunId: string; stepId: string } }) => {
          for (const s of stepExecs.values()) {
            if (s.workflowRunId === where.workflowRunId && s.stepId === where.stepId) return s;
          }
          throw new Error("not found");
        },
      ),
    },
    contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })) },
    activity: { create: vi.fn(async () => ({})) },
    notification: { create: vi.fn(async () => ({})) },
  };
}

let fakeDb: ReturnType<typeof createFakeDb>;

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(async (req: Request) => req.text()),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
  anthropicCreate: vi.fn(async (_args: unknown) => ({
    content: [{ type: "text", text: "ai output" }],
    usage: { output_tokens: 10 },
  })),
  sendEmail: vi.fn(async (_args: unknown) => ({ id: "email-1" })),
  recordUsage: vi.fn(async (..._args: unknown[]) => undefined),
  getDb: vi.fn(() => fakeDb),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    const db = mocks.getDb() as unknown as Record<string, unknown>;
    return {
      ...db,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    };
  },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: mocks.anthropicCreate } },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ model: "utility-model", maxTokens: 100 }),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: mocks.recordUsage }));
// The real component is JSX (emails/workflow-notification.tsx); this suite
// only asserts on claim/idempotency plumbing around email.send, not on
// rendered email markup, so a plain stand-in avoids requiring a JSX/React
// runtime in this test file (unexercised by any other existing test either).
vi.mock("../../emails/workflow-notification", () => ({
  WorkflowNotificationEmail: (props: unknown) => props,
}));

import { POST } from "@/app/api/v1/jobs/run-workflow/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";

function jobRequest(body: Record<string, unknown>): Request {
  return new Request("https://example.test/api/v1/jobs/run-workflow", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "upstash-signature": "sig" },
  });
}

function freshTriggerPayload(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: WORKFLOW,
    orgId: ORG,
    triggerType: "deal.won",
    triggerData: { contactId: "contact-1" },
    sourceEventKey: "deal.won:k1",
    ...overrides,
  };
}

function twoStepWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Two-step workflow",
    isActive: true,
    createdById: "user-1",
    steps: [
      {
        id: "s1",
        type: "crm.create_activity",
        contactIdVar: "trigger.contactId",
        activityType: "NOTE",
        subject: "Deal won",
      },
      { id: "s2", type: "notify.member", title: "Deal won" },
    ],
    ...overrides,
  };
}

async function post(body: Record<string, unknown>) {
  return POST(jobRequest(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb = createFakeDb();
  fakeDb.workflow.findFirst.mockResolvedValue(twoStepWorkflow());
  mocks.verifyJobRequest.mockImplementation(async (req: Request) => req.text());
});

describe("step-level idempotency: crash-and-reclaim replay safety", () => {
  it("does not create a second Activity for s1 when the failed run is reclaimed after s1 already succeeded", async () => {
    // Both steps are crm.create_activity so the only side-effect call in
    // play is activity.create: the 1st (s1) call succeeds, the 2nd (s2)
    // call is made to throw, simulating a crash/error immediately after
    // s1's Activity was durably created and its step-execution claim
    // marked SUCCEEDED (atomically, in one transaction) but before the run
    // as a whole completes.
    fakeDb.workflow.findFirst.mockResolvedValue(
      twoStepWorkflow({
        steps: [
          {
            id: "s1",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "NOTE",
            subject: "Deal won - s1",
          },
          {
            id: "s2",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "NOTE",
            subject: "Deal won - s2",
          },
        ],
      }),
    );
    fakeDb.activity.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("simulated crash after s1"));

    const first = await post(freshTriggerPayload());
    expect(first.status).toBe(500);
    expect(fakeDb.activity.create).toHaveBeenCalledTimes(2);

    // Confirm the run is now FAILED, s1's claim survived as SUCCEEDED, and
    // s2's claim recorded the failure (not left ambiguously CLAIMED).
    const run = [...fakeDb.runs.values()][0]!;
    expect(run.status).toBe("FAILED");
    const s1Exec = [...fakeDb.stepExecs.values()].find((s) => s.stepId === "s1")!;
    const s2Exec = [...fakeDb.stepExecs.values()].find((s) => s.stepId === "s2")!;
    expect(s1Exec.status).toBe("SUCCEEDED");
    expect(s2Exec.status).toBe("FAILED");

    // Attempt 2: same source event redelivered (QStash retry / duplicate
    // emitWorkflowEvent). The run-level claim reclaims the FAILED run; this
    // time s2 succeeds (mock queue exhausted, falls back to the default
    // resolved value).
    const second = await post(freshTriggerPayload());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    // The fix under test: s1's Activity must NOT be created a third time
    // (or a second time) - only s2's legitimate retry adds one more call.
    expect(fakeDb.activity.create).toHaveBeenCalledTimes(3);
  });

  it("reuses the cached ai.generate output on replay instead of billing a second generation", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(
      twoStepWorkflow({
        steps: [
          {
            id: "s1",
            type: "ai.generate",
            prompt: "Summarize {{trigger.contactId}}",
            outputVar: "summary",
          },
          {
            id: "s2",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "NOTE",
            subject: "{{vars.summary}}",
          },
        ],
      }),
    );
    // s1 (ai.generate) never touches activity.create, so rejecting its
    // first call cleanly simulates "s1 succeeded, s2 crashed".
    fakeDb.activity.create.mockRejectedValueOnce(new Error("simulated crash after s1"));

    await post(freshTriggerPayload());
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);

    await post(freshTriggerPayload());

    // No second billable generation call - the durable claim's cached
    // output is reused directly.
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(fakeDb.activity.create).toHaveBeenCalledTimes(2);
  });

  it("passes the same idempotencyKey to Resend on both the original attempt and the retry", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(
      twoStepWorkflow({
        steps: [
          { id: "s1", type: "email.send", to: "guest@example.test", subject: "Hi", body: "Body" },
          {
            id: "s2",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "NOTE",
            subject: "Sent",
          },
        ],
      }),
    );
    fakeDb.activity.create.mockRejectedValueOnce(new Error("simulated crash after s1"));

    await post(freshTriggerPayload());
    const firstKey = (mocks.sendEmail.mock.calls[0]![0] as { idempotencyKey?: string })
      .idempotencyKey;
    expect(firstKey).toBeTruthy();

    await post(freshTriggerPayload());

    // email.send itself is not called again (s1 already SUCCEEDED), so the
    // stable key's whole purpose - protecting a genuine crash-and-resend -
    // is validated by claimStep()'s own dedicated test below; here we just
    // confirm no second send occurs at all for the already-completed step.
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("passes a stable idempotencyKey across a genuine mid-send crash (claim survives, send retried)", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(
      twoStepWorkflow({
        steps: [
          { id: "s1", type: "email.send", to: "guest@example.test", subject: "Hi", body: "Body" },
        ],
      }),
    );
    // First attempt: Resend call itself fails (simulating an ambiguous
    // outcome - e.g. the request timed out after Resend already accepted
    // it). The step's claim is left CLAIMED (not SUCCEEDED).
    mocks.sendEmail.mockRejectedValueOnce(new Error("network timeout"));

    const first = await post(freshTriggerPayload());
    expect(first.status).toBe(500);
    const s1Exec = [...fakeDb.stepExecs.values()][0]!;
    expect(s1Exec.status).toBe("FAILED"); // failStep() records the caught error

    await post(freshTriggerPayload());

    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    const key1 = (mocks.sendEmail.mock.calls[0]![0] as { idempotencyKey?: string }).idempotencyKey;
    const key2 = (mocks.sendEmail.mock.calls[1]![0] as { idempotencyKey?: string }).idempotencyKey;
    expect(key1).toBe(key2); // same claim row (id), reclaimed - Resend sees the same key
  });
});

describe("step-level idempotency: genuinely distinct steps and runs are never suppressed", () => {
  it("a second, later deal.won event (different sourceEventKey) runs its own s1 independently", async () => {
    await post(freshTriggerPayload({ sourceEventKey: "deal.won:k1" }));
    await post(
      freshTriggerPayload({
        sourceEventKey: "deal.won:k2",
        triggerData: { contactId: "contact-2" },
      }),
    );

    expect(fakeDb.activity.create).toHaveBeenCalledTimes(2);
    expect(fakeDb.runs.size).toBe(2);
  });

  it("two different steps in the same run (s1, s2) each execute exactly once, independently claimed", async () => {
    await post(freshTriggerPayload());

    expect(fakeDb.activity.create).toHaveBeenCalledTimes(1);
    expect(fakeDb.notification.create).toHaveBeenCalledTimes(1);
    expect(fakeDb.stepExecs.size).toBe(2);
    const ids = [...fakeDb.stepExecs.values()].map((s) => s.stepId).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });
});

describe("step-level idempotency: manual runs are unaffected", () => {
  it("a manual run (runId supplied directly, no sourceEventKey) executes its steps normally, once", async () => {
    const run = await fakeDb.workflowRun.create({
      data: { workflowId: WORKFLOW, organizationId: ORG, triggerData: {}, sourceEventKey: null },
    });

    const res = await post({
      workflowId: WORKFLOW,
      orgId: ORG,
      triggerType: "manual",
      triggerData: { contactId: "contact-1" },
      runId: run.id,
      resumeFromIndex: 0,
    });

    expect(res.status).toBe(200);
    expect(fakeDb.activity.create).toHaveBeenCalledTimes(1);
    expect(fakeDb.notification.create).toHaveBeenCalledTimes(1);
  });

  it("two independent manual runs of the same workflow each execute s1 once (no cross-run suppression)", async () => {
    const runA = await fakeDb.workflowRun.create({
      data: { workflowId: WORKFLOW, organizationId: ORG, triggerData: {}, sourceEventKey: null },
    });
    const runB = await fakeDb.workflowRun.create({
      data: { workflowId: WORKFLOW, organizationId: ORG, triggerData: {}, sourceEventKey: null },
    });

    await post({
      workflowId: WORKFLOW,
      orgId: ORG,
      triggerType: "manual",
      triggerData: {},
      runId: runA.id,
      resumeFromIndex: 0,
    });
    await post({
      workflowId: WORKFLOW,
      orgId: ORG,
      triggerType: "manual",
      triggerData: {},
      runId: runB.id,
      resumeFromIndex: 0,
    });

    expect(fakeDb.activity.create).toHaveBeenCalledTimes(2);
  });
});

describe("step-level idempotency: concurrent overlap during a stale run-level reclaim", () => {
  it("a step still CLAIMED and not yet stale is not re-executed by a second claimant", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(
      twoStepWorkflow({
        steps: [
          {
            id: "s1",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "NOTE",
            subject: "x",
          },
        ],
      }),
    );
    // Pre-seed a run and a step-execution row that's CLAIMED but fresh
    // (simulating a worker that is genuinely still mid-step, not crashed).
    const run = await fakeDb.workflowRun.create({
      data: {
        workflowId: WORKFLOW,
        organizationId: ORG,
        triggerData: {},
        sourceEventKey: "deal.won:overlap",
      },
    });
    await fakeDb.workflowStepExecution.create({
      data: { organizationId: ORG, workflowRunId: run.id, stepId: "s1" },
    });

    const res = await post(
      freshTriggerPayload({
        sourceEventKey: "deal.won:overlap",
        runId: run.id,
        resumeFromIndex: 0,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "step_in_progress" });
    expect(fakeDb.activity.create).not.toHaveBeenCalled();
  });
});

describe("step-level idempotency: fencing against a stale-but-still-alive worker", () => {
  it("a belated completion using a superseded (pre-reclaim) claim is rejected instead of double-executing the side effect", async () => {
    // See tests/integration/run-workflow-step-fencing.mjs for the real-
    // Postgres version of this exact scenario (this test proves the same
    // control flow at the application/mock level).
    const run = await fakeDb.workflowRun.create({
      data: {
        workflowId: WORKFLOW,
        organizationId: ORG,
        triggerData: {},
        sourceEventKey: "deal.won:fencing",
      },
    });

    // Worker A's original claim - already stale (older than
    // STALE_STEP_CLAIM_MS), simulating a worker that is slow, not dead.
    // Worker A's own remembered claim.startedAt is exactly this same value:
    // it's what claimStep() returned to Worker A at the (simulated) moment
    // it claimed, and never changes on Worker A's side afterward.
    const workerAClaim = await fakeDb.workflowStepExecution.create({
      data: { organizationId: ORG, workflowRunId: run.id, stepId: "s1" },
    });
    const workerAStartedAt = new Date(Date.now() - 10 * 60_000);
    workerAClaim.startedAt = workerAStartedAt;
    fakeDb.stepExecs.set(workerAClaim.id, workerAClaim);

    fakeDb.workflow.findFirst.mockResolvedValue(
      twoStepWorkflow({
        steps: [
          {
            id: "s1",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "NOTE",
            subject: "Worker B's activity",
          },
        ],
      }),
    );

    // Worker B (a fresh delivery) drives the run through the real route,
    // reclaims s1 as stale, and completes it normally.
    const resB = await post(
      freshTriggerPayload({
        sourceEventKey: "deal.won:fencing",
        runId: run.id,
        resumeFromIndex: 0,
      }),
    );
    expect(resB.status).toBe(200);
    expect(fakeDb.activity.create).toHaveBeenCalledTimes(1);
    expect(fakeDb.stepExecs.get(workerAClaim.id)!.status).toBe("SUCCEEDED");

    // Worker A, unaware it was reclaimed, now belatedly tries to complete
    // the same step using its own (now-superseded) claim - exactly what
    // completeStep()'s fencing-guarded updateMany does internally.
    const belated = await fakeDb.workflowStepExecution.updateMany({
      where: { id: workerAClaim.id, startedAt: workerAStartedAt },
      data: { status: "SUCCEEDED", finishedAt: new Date() },
    });

    // Rejected: Worker B's reclaim already advanced startedAt, so Worker
    // A's write matches zero rows instead of silently overwriting Worker
    // B's result (or, in the real crm.create_activity transaction, instead
    // of durably committing a second Activity - see the .mjs script).
    expect(belated.count).toBe(0);
    expect(fakeDb.stepExecs.get(workerAClaim.id)!.status).toBe("SUCCEEDED");
  });
});
