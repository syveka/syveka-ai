import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A run-workflow delivery stops before any step side effect when:
 *  - the workflow has been deactivated, including the delayed resume of a run
 *    parked on a wait.duration step (the run ends CANCELED), and
 *  - the organization is missing or soft-deleted (the run is left as it was).
 * Both are HTTP 200 so QStash does not retry. A manual test run still bypasses
 * isActive, as testWorkflowAction intends.
 *
 * Synthetic data, a small in-memory fake, and mocked providers (no real email
 * or AI calls).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const CREATOR = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  orgDeleted: false,
  failOrgLookup: false,
  workflow: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
  stepExecs: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
}));
const fx = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ id: "email-1" })),
  anthropic: vi.fn(async () => ({
    content: [{ type: "text", text: "ai output" }],
    usage: { output_tokens: 1 },
  })),
  enqueue: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
}));

function notFound(): Error {
  return Object.assign(new Error("Record not found"), { code: "P2025" });
}

const db = {
  organization: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      if (state.failOrgLookup) throw new Error("database unavailable");
      return where.id === ORG && !state.orgDeleted ? { id: ORG } : null;
    }),
  },
  workflow: {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.workflow &&
      state.workflow.id === where.id &&
      state.workflow.organizationId === where.organizationId
        ? state.workflow
        : null,
    ),
  },
  workflowRun: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const run = { id: `run-${state.runs.length + 1}`, stepResults: [], ...data };
      state.runs.push(run);
      return run;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find(
        (r) =>
          r.id === where.id &&
          (where.workflowId === undefined || r.workflowId === where.workflowId) &&
          (where.organizationId === undefined || r.organizationId === where.organizationId),
      );
      if (!run) throw notFound();
      Object.assign(run, data);
      return run;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const allowed = (where.status as { in?: string[] } | undefined)?.in;
      const matched = state.runs.filter(
        (r) =>
          r.id === where.id &&
          r.workflowId === where.workflowId &&
          r.organizationId === where.organizationId &&
          (!allowed || allowed.includes(r.status as string)),
      );
      matched.forEach((r) => Object.assign(r, data));
      return { count: matched.length };
    }),
  },
  workflowStepExecution: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const exec = {
        id: `exec-${state.stepExecs.length + 1}`,
        startedAt: new Date(),
        ...data,
      };
      state.stepExecs.push(exec);
      return exec;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const exec = state.stepExecs.find((s) => s.id === where.id);
      if (!exec) return { count: 0 };
      Object.assign(exec, data);
      return { count: 1 };
    }),
  },
  organizationMember: {
    findFirst: vi.fn(async () => (state.orgDeleted ? null : { id: "member-1" })),
  },
  notification: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      state.notifications.push(data);
      return data;
    }),
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (req: Request) => req.text() }));
// A getter: the guard below is loaded before `db` is initialized.
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: fx.enqueue }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: fx.anthropic } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: fx.sendEmail }));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: fx.recordUsage }));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

// Loaded up front, as in jobs-organization-guard.test.ts: a first-time
// concurrent dynamic import of a mocked module can resolve the real one.
import "@/server/jobs/organization-guard";
import { POST } from "@/app/api/v1/jobs/run-workflow/route";

// wait -> email.send -> ai.generate: the resume after the wait runs the last two.
const STEPS = [
  { id: "w1", type: "wait.duration", seconds: 86_400 },
  { id: "e1", type: "email.send", to: "lead@example.test", subject: "Hi", body: "Hello" },
  { id: "a1", type: "ai.generate", prompt: "Summarize", outputVar: "summary" },
];

function workflow(isActive: boolean) {
  state.workflow = {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Follow-up",
    isActive,
    createdById: CREATOR,
    steps: STEPS,
  };
}

function waitingRun() {
  state.runs.push({
    id: RUN,
    workflowId: WORKFLOW,
    organizationId: ORG,
    status: "WAITING",
    triggerData: {},
    stepResults: [{ stepId: "w1", status: "ok" }],
    error: null,
    finishedAt: null,
  });
}

function deliver(body: Record<string, unknown>) {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      body: JSON.stringify({
        workflowId: WORKFLOW,
        orgId: ORG,
        triggerType: "deal.won",
        triggerData: {},
        ...body,
      }),
    }),
  );
}

const resume = () => deliver({ runId: RUN, resumeFromIndex: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  state.orgDeleted = false;
  state.failOrgLookup = false;
  state.workflow = null;
  state.runs = [];
  state.stepExecs = [];
  state.notifications = [];
});

describe("deactivated workflow", () => {
  it("control: resuming a WAITING run of an active workflow executes the remaining steps", async () => {
    workflow(true);
    waitingRun();
    const res = await resume();
    expect(res.status).toBe(200);
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(fx.anthropic).toHaveBeenCalledTimes(1);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
  });

  it("resuming a WAITING run after deactivation sends nothing and ends the run CANCELED", async () => {
    workflow(false);
    waitingRun();
    const res = await resume();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "workflow inactive or gone" });
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.anthropic).not.toHaveBeenCalled();
    expect(fx.enqueue).not.toHaveBeenCalled();
    expect(state.stepExecs).toEqual([]);
    expect(state.runs[0]).toMatchObject({
      status: "CANCELED",
      error: "workflow_deactivated",
      finishedAt: expect.any(Date),
    });
  });

  it("a redelivered resume of an already-finished run does not rewrite its status", async () => {
    workflow(false);
    waitingRun();
    state.runs[0]!.status = "SUCCEEDED";
    const res = await resume();
    expect(res.status).toBe(200);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED", error: null });
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("existing behavior: a fresh trigger for an inactive workflow is skipped without a run", async () => {
    workflow(false);
    const res = await deliver({ sourceEventKey: "deal.won:d1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "workflow inactive or gone" });
    expect(state.runs).toEqual([]);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("existing behavior: a manual test run of an inactive workflow still executes", async () => {
    workflow(false);
    state.workflow!.steps = STEPS.slice(1);
    waitingRun();
    state.runs[0]!.status = "RUNNING";
    const res = await deliver({ triggerType: "manual", runId: RUN, resumeFromIndex: 0 });
    expect(res.status).toBe(200);
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
  });
});

describe("missing or soft-deleted organization", () => {
  it("a fresh trigger is skipped with HTTP 200 before any run or step", async () => {
    workflow(true);
    state.orgDeleted = true;
    const res = await deliver({ sourceEventKey: "deal.won:d1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "organization_inactive" });
    expect(state.runs).toEqual([]);
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.anthropic).not.toHaveBeenCalled();
  });

  it("a WAITING run's resume executes no step and leaves the run as it was", async () => {
    workflow(true);
    waitingRun();
    state.orgDeleted = true;
    const res = await resume();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "organization_inactive" });
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.anthropic).not.toHaveBeenCalled();
    expect(state.stepExecs).toEqual([]);
    expect(state.notifications).toEqual([]);
    expect(state.runs[0]).toMatchObject({ status: "WAITING" });
  });

  it("a guard database error is an error (queue retries), not a skip", async () => {
    workflow(true);
    waitingRun();
    state.failOrgLookup = true;
    await expect(resume()).rejects.toThrow("database unavailable");
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(state.runs[0]).toMatchObject({ status: "WAITING" });
  });
});
