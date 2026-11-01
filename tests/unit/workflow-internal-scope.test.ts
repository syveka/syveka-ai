import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Internal-only workflow scope (Organization.settings
 * workflow_steps_internal_only = true): an organization granted ACTIVE_WORKFLOWS
 * for a pilot may only run condition, crm.create_activity and notify.member
 * steps. A general ACTIVE_WORKFLOWS grant would otherwise authorize email.send
 * (real email), ai.generate (paid model call), wait.duration (delayed queue
 * resume) and the schedule.cron trigger.
 *
 * Enforced on save, activation, test runs and in the run-workflow job before
 * any step executes (so a workflow saved before the flag can't run either).
 * Organizations without the flag are unaffected (control cases).
 *
 * Synthetic data, an in-memory fake database, mocked providers: no real email,
 * model call or queue message.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const CREATOR = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  internalOnly: true,
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
  assertWithinLimit: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  isRestrictionSet: vi.fn(async (_org: string, key: string) =>
    key === "workflow_steps_internal_only" ? state.internalOnly : false,
  ),
  serviceCreate: vi.fn(async ({ data }: { data: Row }) => ({ id: "wf-new", ...data })),
  serviceUpdate: vi.fn(async () => ({})),
}));

const db = {
  organization: { findFirst: vi.fn(async () => ({ id: ORG })) },
  workflow: {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.workflow && state.workflow.id === where.id ? state.workflow : null,
    ),
  },
  workflowRun: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const run = { id: `run-${state.runs.length + 1}`, stepResults: [], ...data };
      state.runs.push(run);
      return run;
    }),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find((r) => r.id === where.id)!;
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
      const exec = { id: `exec-${state.stepExecs.length + 1}`, startedAt: new Date(), ...data };
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
  organizationMember: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
  notification: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      state.notifications.push(data);
      return data;
    }),
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};

/** Tenant-scoped view used by the workflows service. */
const serviceDb = {
  workflow: {
    findFirstOrThrow: vi.fn(async () => state.workflow),
    count: vi.fn(async () => 0),
    create: fx.serviceCreate,
    update: fx.serviceUpdate,
  },
  organizationMember: { count: vi.fn(async () => 1) },
};

vi.mock("@/server/services/feature-flags", () => ({ isRestrictionSet: fx.isRestrictionSet }));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (req: Request) => req.text() }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: () => serviceDb,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: fx.enqueue }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: fx.anthropic } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: fx.sendEmail }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: fx.recordUsage,
  getEntitlements: async () => ({ readOnly: false, activeWorkflows: 1 }),
  assertWithinLimit: fx.assertWithinLimit,
  EntitlementError: class extends Error {},
}));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: async () => undefined,
  AiSpendError: class extends Error {},
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

import "@/server/jobs/organization-guard";
import { POST } from "@/app/api/v1/jobs/run-workflow/route";
import { internalScopeViolations } from "@/lib/workflows/internal-scope";
import { setWorkflowActive, upsertWorkflow, WorkflowError } from "@/server/services/workflows";

const ctx = { orgId: ORG, userId: CREATOR, role: "OWNER" } as never;
const EMAIL = {
  id: "e1",
  type: "email.send",
  to: "lead@example.test",
  subject: "Hi",
  body: "Hello",
};
const AI = { id: "a1", type: "ai.generate", prompt: "Summarize", outputVar: "summary" };
const WAIT = { id: "w1", type: "wait.duration", seconds: 3600 };
const NOTE = {
  id: "c1",
  type: "crm.create_activity",
  contactIdVar: "trigger.contactId",
  activityType: "NOTE",
  subject: "Pilot workflow activity test",
};
const NOTIFY = { id: "n1", type: "notify.member", title: "New contact" };
const COND = { id: "k1", type: "condition", field: "trigger.contactId", comparator: "exists" };

function setWorkflow(
  steps: unknown[],
  isActive = true,
  trigger: unknown = { type: "contact.created" },
) {
  state.workflow = {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Pilot",
    isActive,
    createdById: CREATOR,
    trigger,
    steps,
  };
}

function deliver(body: Record<string, unknown>) {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      body: JSON.stringify({
        workflowId: WORKFLOW,
        orgId: ORG,
        triggerType: "contact.created",
        triggerData: { contactId: "c-1" },
        ...body,
      }),
    }),
  );
}

const noSideEffects = () => {
  expect(fx.sendEmail).not.toHaveBeenCalled();
  expect(fx.anthropic).not.toHaveBeenCalled();
  expect(fx.enqueue).not.toHaveBeenCalled();
  expect(state.stepExecs).toHaveLength(0);
  expect(state.notifications).toHaveLength(0);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.internalOnly = true;
  state.workflow = null;
  state.runs = [];
  state.stepExecs = [];
  state.notifications = [];
});

describe("internalScopeViolations", () => {
  it("allows conditions, CRM activities and in-app member notifications", () => {
    expect(internalScopeViolations({ type: "contact.created" }, [COND, NOTE, NOTIFY])).toEqual([]);
  });

  it("refuses email, AI, wait steps and the cron trigger", () => {
    expect(internalScopeViolations({ type: "contact.created" }, [NOTE, EMAIL, AI, WAIT])).toEqual([
      "step:email.send",
      "step:ai.generate",
      "step:wait.duration",
    ]);
    expect(internalScopeViolations({ type: "schedule.cron", cron: "0 9 * * 1" }, [NOTE])).toEqual([
      "trigger:schedule.cron",
    ]);
  });

  it("fails closed on anything it can't read", () => {
    expect(internalScopeViolations(null, [NOTE])).toEqual(["trigger:undefined"]);
    expect(internalScopeViolations({ type: "contact.created" }, "nope")).toEqual(["steps:invalid"]);
    expect(internalScopeViolations({ type: "contact.created" }, [{ type: 7 }])).toEqual(["step:7"]);
  });
});

describe("save and activation (workflows service)", () => {
  const input = (steps: unknown[]) =>
    ({ name: "Pilot", description: "", trigger: { type: "contact.created" }, steps }) as never;

  it("refuses to save an email/AI/wait step for an internal-only organization, writing nothing", async () => {
    for (const step of [EMAIL, AI, WAIT]) {
      await expect(upsertWorkflow(ctx, input([NOTE, step]))).rejects.toMatchObject({
        code: "step_not_allowed",
      });
    }
    expect(fx.serviceCreate).not.toHaveBeenCalled();
    expect(fx.serviceUpdate).not.toHaveBeenCalled();
  });

  it("saves an internal-only workflow there, and anything for other organizations", async () => {
    await upsertWorkflow(ctx, input([NOTE, NOTIFY]));
    expect(fx.serviceCreate).toHaveBeenCalledTimes(1);
    state.internalOnly = false;
    await upsertWorkflow(ctx, input([EMAIL]));
    expect(fx.serviceCreate).toHaveBeenCalledTimes(2);
  });

  it("refuses to activate a stored out-of-scope workflow before any limit check or write", async () => {
    setWorkflow([NOTE, EMAIL], false);
    const error = await setWorkflowActive(ctx, WORKFLOW, true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe("step_not_allowed");
    expect(fx.assertWithinLimit).not.toHaveBeenCalled();
    expect(fx.serviceUpdate).not.toHaveBeenCalled();
  });

  it("deactivation is never blocked", async () => {
    setWorkflow([EMAIL], true);
    await setWorkflowActive(ctx, WORKFLOW, false);
    expect(fx.serviceUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("run-workflow job: nothing outside the scope executes", () => {
  it("a fresh trigger of an out-of-scope workflow runs no step and creates no run", async () => {
    setWorkflow([NOTE, EMAIL, AI]);
    const res = await deliver({ sourceEventKey: "contact.created:c-1" });
    expect(await res.json()).toEqual({ skipped: "step_not_allowed" });
    expect(state.runs).toHaveLength(0);
    noSideEffects();
  });

  it("a manual test run is marked FAILED step_not_allowed, with no side effect", async () => {
    setWorkflow([EMAIL], false);
    state.runs.push({ id: RUN, workflowId: WORKFLOW, organizationId: ORG, status: "RUNNING" });
    const res = await deliver({ triggerType: "manual", runId: RUN, resumeFromIndex: 0 });
    expect(await res.json()).toEqual({ skipped: "step_not_allowed" });
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: "step_not_allowed" });
    noSideEffects();
  });

  it("a run parked on a wait (saved before the restriction) does not resume into email or AI", async () => {
    setWorkflow([WAIT, EMAIL, AI]);
    state.runs.push({ id: RUN, workflowId: WORKFLOW, organizationId: ORG, status: "WAITING" });
    await deliver({ runId: RUN, resumeFromIndex: 1 });
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: "step_not_allowed" });
    noSideEffects();
  });

  it("a cron-triggered workflow is refused even with only internal steps", async () => {
    setWorkflow([NOTE], true, { type: "schedule.cron", cron: "0 9 * * 1" });
    const res = await deliver({ sourceEventKey: "cron:1" });
    expect(await res.json()).toEqual({ skipped: "step_not_allowed" });
    noSideEffects();
  });

  it("control: an in-scope workflow still runs (in-app notification written)", async () => {
    setWorkflow([NOTIFY]);
    const res = await deliver({ sourceEventKey: "contact.created:c-2" });
    expect(res.status).toBe(200);
    expect(state.notifications).toHaveLength(1);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("control: an organization without the flag keeps every step type", async () => {
    state.internalOnly = false;
    setWorkflow([EMAIL]);
    await deliver({ sourceEventKey: "contact.created:c-3" });
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
  });
});
