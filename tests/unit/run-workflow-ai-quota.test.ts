import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan and AI-quota gating in the run-workflow job: a fresh trigger needs a
 * plan that includes workflows, and an ai.generate step needs AI message
 * quota and counts against it. The quota check runs through the real
 * assertAiQuotaAvailable (src/server/services/ai-spend.ts) against a mocked
 * entitlements module.
 */

class FakePrismaKnownError extends Error {
  constructor(readonly code: string) {
    super(`Prisma error ${code}`);
  }
}

type Run = {
  id: string;
  workflowId: string;
  organizationId: string;
  status: string;
  stepResults: unknown;
  sourceEventKey: string | null;
  error: string | null;
  startedAt: Date;
};
type StepExec = {
  id: string;
  workflowRunId: string;
  stepId: string;
  status: string;
  output: unknown;
  error: string | null;
  startedAt: Date;
};

function createFakeDb() {
  const runs = new Map<string, Run>();
  const stepExecs = new Map<string, StepExec>();
  let seq = 0;
  const nextId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;

  return {
    runs,
    stepExecs,
    workflow: { findFirst: vi.fn() },
    workflowRun: {
      create: vi.fn(async ({ data }: { data: Partial<Run> }) => {
        for (const r of runs.values()) {
          if (data.sourceEventKey != null && r.sourceEventKey === data.sourceEventKey) {
            throw new FakePrismaKnownError("P2002");
          }
        }
        const run: Run = {
          id: nextId(),
          workflowId: data.workflowId!,
          organizationId: data.organizationId!,
          status: data.status ?? "RUNNING",
          stepResults: [],
          sourceEventKey: data.sourceEventKey ?? null,
          error: null,
          startedAt: new Date(),
        };
        runs.set(run.id, run);
        return run;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Run> }) => {
        const run = runs.get(where.id);
        if (!run) throw new FakePrismaKnownError("P2025");
        Object.assign(run, data);
        return run;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
      findFirstOrThrow: vi.fn(),
    },
    workflowStepExecution: {
      create: vi.fn(async ({ data }: { data: Partial<StepExec> }) => {
        for (const s of stepExecs.values()) {
          if (s.workflowRunId === data.workflowRunId && s.stepId === data.stepId) {
            throw new FakePrismaKnownError("P2002");
          }
        }
        const exec: StepExec = {
          id: nextId(),
          workflowRunId: data.workflowRunId!,
          stepId: data.stepId!,
          status: data.status ?? "CLAIMED",
          output: null,
          error: null,
          startedAt: new Date(),
        };
        stepExecs.set(exec.id, exec);
        return exec;
      }),
      // Only the fencing-guarded completion/failure writes reach this mock.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; startedAt: Date };
          data: Partial<StepExec>;
        }) => {
          const s = stepExecs.get(where.id);
          if (!s || s.startedAt.getTime() !== where.startedAt.getTime()) return { count: 0 };
          Object.assign(s, data);
          return { count: 1 };
        },
      ),
      findFirstOrThrow: vi.fn(
        async ({ where }: { where: { workflowRunId: string; stepId: string } }) => {
          for (const s of stepExecs.values()) {
            if (s.workflowRunId === where.workflowRunId && s.stepId === where.stepId) return s;
          }
          throw new Error("not found");
        },
      ),
    },
    notification: { create: vi.fn(async () => ({})) },
    organizationMember: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
  };
}

let fakeDb: ReturnType<typeof createFakeDb>;

const fx = vi.hoisted(() => {
  class EntitlementError extends Error {}
  const state = {
    entitlements: { readOnly: false, activeWorkflows: 5, aiMessagesPerOrgMonth: 100 },
    aiMessagesUsed: 0,
  };
  return {
    state,
    EntitlementError,
    verifyJobRequest: async (req: Request) => req.text(),
    anthropicCreate: vi.fn(async (_args: unknown) => ({
      content: [{ type: "text", text: "ai output" }],
      usage: { output_tokens: 10 },
    })),
    recordUsage: vi.fn(async (..._args: unknown[]) => undefined),
    getEntitlements: vi.fn(async (_orgId: string) => ({ ...state.entitlements })),
    getMonthUsage: vi.fn(async (_orgId: string, _metric: string) => state.aiMessagesUsed),
    // Mirrors the real assertWithinLimit for kind "ai_messages".
    assertWithinLimit: vi.fn(async (_orgId: string, check: { orgMonthCount: number }) => {
      if (state.entitlements.readOnly) throw new EntitlementError("read-only");
      if (check.orgMonthCount >= state.entitlements.aiMessagesPerOrgMonth) {
        throw new EntitlementError("Monthly AI message quota reached.");
      }
      return { ...state.entitlements };
    }),
  };
});

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: fx.verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return {
      ...fakeDb,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
    };
  },
}));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: async () => true,
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: fx.anthropicCreate } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/integrations/redis", () => ({ limitAiChat: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: fx.recordUsage,
  getEntitlements: fx.getEntitlements,
  getMonthUsage: fx.getMonthUsage,
  assertWithinLimit: fx.assertWithinLimit,
  EntitlementError: fx.EntitlementError,
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

// Loaded up front, as in jobs-organization-guard.test.ts: a first-time
// concurrent dynamic import of a mocked module can resolve the real one.
import "@/server/jobs/organization-guard";
import "@/server/services/ai-spend";
import { POST } from "@/app/api/v1/jobs/run-workflow/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const CREATOR = "33333333-3333-4333-8333-333333333333";

const aiStep = { id: "s1", type: "ai.generate", prompt: "Summarize", outputVar: "summary" };
const notifyStep = { id: "n1", type: "notify.member", title: "Booked" };

function workflowWith(steps: unknown[]) {
  return {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Booking follow-up",
    isActive: true,
    createdById: CREATOR,
    steps,
  };
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

// An anonymous public booking emits exactly this kind of fresh trigger.
const bookingTrigger = {
  workflowId: WORKFLOW,
  orgId: ORG,
  triggerType: "booking.created",
  triggerData: { bookingId: "b1" },
  sourceEventKey: "booking.created:b1",
};

function aiUsageCalls() {
  return fx.recordUsage.mock.calls.filter(
    ([, metric]) => metric === "AI_MESSAGES" || metric === "AI_TOKENS_OUT",
  );
}

function failureNotifications() {
  return fakeDb.notification.create.mock.calls.filter(
    (call) => (call as unknown as [{ data: { type: string } }])[0].data.type === "workflow.failed",
  );
}

async function seedRun(status: string) {
  return fakeDb.workflowRun.create({
    data: { workflowId: WORKFLOW, organizationId: ORG, status, sourceEventKey: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb = createFakeDb();
  fx.state.entitlements = { readOnly: false, activeWorkflows: 5, aiMessagesPerOrgMonth: 100 };
  fx.state.aiMessagesUsed = 0;
});

describe("ai.generate AI quota", () => {
  it("over quota: refuses the step before calling the provider, fails the run once, answers 200", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([aiStep]));
    fx.state.aiMessagesUsed = 100;

    const res = await post(bookingTrigger);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refused: "ai_quota_exceeded" });
    expect(fx.anthropicCreate).not.toHaveBeenCalled();
    const exec = [...fakeDb.stepExecs.values()][0]!;
    expect(exec.status).toBe("FAILED");
    expect(exec.error).toBe("ai_quota_exceeded");
    const run = [...fakeDb.runs.values()][0]!;
    expect(run.status).toBe("FAILED");
    expect(run.error).toBe("ai_quota_exceeded");
    expect(failureNotifications()).toHaveLength(1);
    expect(aiUsageCalls()).toHaveLength(0);
  });

  it("a read-only org is refused the same way", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([aiStep]));
    const run = await seedRun("WAITING");
    fx.state.entitlements.readOnly = true;

    const res = await post({ ...bookingTrigger, sourceEventKey: undefined, runId: run.id });

    expect(res.status).toBe(200);
    expect(fx.anthropicCreate).not.toHaveBeenCalled();
    expect(fakeDb.runs.get(run.id)!.status).toBe("FAILED");
  });

  it("within quota: counts one AI message for the generation", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([aiStep]));

    const res = await post(bookingTrigger);

    expect(res.status).toBe(200);
    expect(fx.anthropicCreate).toHaveBeenCalledTimes(1);
    const run = [...fakeDb.runs.values()][0]!;
    const messages = fx.recordUsage.mock.calls.filter(([, metric]) => metric === "AI_MESSAGES");
    expect(messages).toEqual([
      [
        ORG,
        "AI_MESSAGES",
        1,
        { feature: "workflow", workflowId: WORKFLOW, runId: run.id, stepId: "s1" },
      ],
    ]);
    expect(fx.recordUsage.mock.calls.filter(([, m]) => m === "AI_TOKENS_OUT")).toHaveLength(1);
  });

  it("a replayed SUCCEEDED step is neither re-checked nor re-counted", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([aiStep]));
    const run = await seedRun("WAITING");
    await fakeDb.workflowStepExecution.create({
      data: { workflowRunId: run.id, stepId: "s1", status: "SUCCEEDED" },
    });
    [...fakeDb.stepExecs.values()][0]!.output = "cached";
    fx.state.aiMessagesUsed = 100; // would be refused if checked

    const res = await post({ ...bookingTrigger, sourceEventKey: undefined, runId: run.id });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fx.getMonthUsage).not.toHaveBeenCalled();
    expect(fx.assertWithinLimit).not.toHaveBeenCalled();
    expect(fx.anthropicCreate).not.toHaveBeenCalled();
    expect(aiUsageCalls()).toHaveLength(0);
  });

  it("a completion that lost the fencing race records no usage", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([aiStep]));
    // Another worker reclaims the step while the provider call is in flight.
    fx.anthropicCreate.mockImplementationOnce(async () => {
      const exec = [...fakeDb.stepExecs.values()][0]!;
      exec.startedAt = new Date(exec.startedAt.getTime() + 1000);
      return { content: [{ type: "text", text: "ai output" }], usage: { output_tokens: 10 } };
    });

    const res = await post(bookingTrigger);

    expect(res.status).toBe(200);
    expect(fx.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(aiUsageCalls()).toHaveLength(0);
  });
});

describe("plan gate on fresh triggers", () => {
  it.each([
    ["FREE plan (no active workflows)", { readOnly: false, activeWorkflows: 0 }],
    ["read-only org", { readOnly: true, activeWorkflows: 5 }],
  ])("%s: the trigger is skipped without creating a run", async (_label, entitlements) => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([aiStep]));
    Object.assign(fx.state.entitlements, entitlements);

    const res = await post(bookingTrigger);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "plan_not_entitled" });
    expect(fakeDb.workflowRun.create).not.toHaveBeenCalled();
    expect(fakeDb.workflowStepExecution.create).not.toHaveBeenCalled();
    expect(fakeDb.runs.size).toBe(0);
    expect(fx.anthropicCreate).not.toHaveBeenCalled();
  });

  it("a wait-step resume is not gated by the plan", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([notifyStep]));
    const run = await seedRun("WAITING");
    fx.state.entitlements.activeWorkflows = 0;

    const res = await post({ ...bookingTrigger, sourceEventKey: undefined, runId: run.id });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fx.getEntitlements).not.toHaveBeenCalled();
    expect(fakeDb.runs.get(run.id)!.status).toBe("SUCCEEDED");
  });

  it("a manual test run is not gated by the plan", async () => {
    fakeDb.workflow.findFirst.mockResolvedValue(workflowWith([notifyStep]));
    const run = await seedRun("RUNNING");
    fx.state.entitlements.activeWorkflows = 0;

    const res = await post({
      workflowId: WORKFLOW,
      orgId: ORG,
      triggerType: "manual",
      triggerData: { test: true },
      runId: run.id,
      resumeFromIndex: 0,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fx.getEntitlements).not.toHaveBeenCalled();
    expect(fakeDb.runs.get(run.id)!.status).toBe("SUCCEEDED");
  });
});
