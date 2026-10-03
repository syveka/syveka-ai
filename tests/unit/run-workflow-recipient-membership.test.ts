import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #73 residual: notify.member and workflow.failed notifications are written
 * only to users who are members of the workflow's organization when the
 * notification is about to be written, and only while that organization
 * isn't soft-deleted. The save-time check (upsertWorkflow) can't see a
 * member removed later, or a creator who left.
 *
 * A small stateful fake of the tables the route touches; the membership
 * lookup honours organizationId, userId and organization.deletedAt exactly
 * as the route queries them.
 */
class FakePrismaKnownError extends Error {
  constructor(readonly code: string) {
    super(`Prisma error ${code}`);
  }
}

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ORG_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  workflow: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
  steps: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<{ organizationId: string; userId: string }>,
  deletedOrgs: new Set<string>(),
  memberLookups: [] as unknown[],
  failMembershipLookups: 0,
}));

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => k === "OR" || row[k] === v);
}

const db = {
  workflow: {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.workflow && matches(state.workflow, where) ? state.workflow : null,
    ),
  },
  workflowRun: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.runs.some((r) => r.sourceEventKey === data.sourceEventKey)) {
        throw new FakePrismaKnownError("P2002");
      }
      const run = {
        id: `run-${state.runs.length + 1}`,
        stepResults: [],
        startedAt: new Date(),
        ...data,
      };
      state.runs.push(run);
      return run;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) => state.runs.find((r) => matches(r, where)) ?? null,
    ),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Row }) =>
      state.runs.find((r) => matches(r, where))!,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find((r) => matches(r, where) && r.status === "FAILED");
      if (!run) return { count: 0 };
      Object.assign(run, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find((r) => r.id === where.id)!;
      Object.assign(run, data);
      return run;
    }),
  },
  workflowStepExecution: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (
        state.steps.some((s) => s.workflowRunId === data.workflowRunId && s.stepId === data.stepId)
      ) {
        throw new FakePrismaKnownError("P2002");
      }
      const step = {
        id: `step-${state.steps.length + 1}`,
        startedAt: new Date(),
        output: null,
        ...data,
      };
      state.steps.push(step);
      return step;
    }),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Row }) =>
      state.steps.find((s) => matches(s, where))!,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const step = state.steps.find(
        (s) =>
          s.id === where.id &&
          (where.startedAt === undefined ||
            (s.startedAt as Date).getTime() === (where.startedAt as Date).getTime()) &&
          (where.OR === undefined || s.status === "FAILED"),
      );
      if (!step) return { count: 0 };
      Object.assign(step, data);
      return { count: 1 };
    }),
  },
  organizationMember: {
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where: { organizationId: string; userId: string; organization?: { deletedAt: null } };
      }) => {
        state.memberLookups.push(where);
        if (state.failMembershipLookups > 0) {
          state.failMembershipLookups -= 1;
          throw new Error("database unavailable");
        }
        if (where.organization?.deletedAt === null && state.deletedOrgs.has(where.organizationId))
          return null;
        const found = state.memberships.find(
          (m) => m.organizationId === where.organizationId && m.userId === where.userId,
        );
        return found ? { id: `${found.organizationId}:${found.userId}` } : null;
      },
    ),
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
vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: db }));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: vi.fn(async () => undefined),
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

import { POST } from "@/app/api/v1/jobs/run-workflow/route";

function deliver(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      body: JSON.stringify({
        workflowId: WORKFLOW,
        orgId: ORG_A,
        triggerType: "deal.won",
        triggerData: { dealId: "d1" },
        sourceEventKey: "deal.won:d1",
        ...overrides,
      }),
    }),
  );
}

function workflowWithSteps(steps: unknown[]) {
  state.workflow = {
    id: WORKFLOW,
    organizationId: ORG_A,
    name: "Deal won",
    isActive: true,
    createdById: CREATOR,
    steps,
  };
}

const notifyStep = (userId?: string) => ({
  id: "s1",
  type: "notify.member",
  title: "Deal won",
  ...(userId ? { userId } : {}),
});
// An ai.generate step whose provider call fails makes the run fail.
const failingStep = { id: "s2", type: "ai.generate", prompt: "x", saveAs: "out" };

beforeEach(() => {
  state.runs = [];
  state.steps = [];
  state.notifications = [];
  state.memberLookups = [];
  state.failMembershipLookups = 0;
  state.deletedOrgs = new Set();
  state.memberships = [
    { organizationId: ORG_A, userId: CREATOR },
    { organizationId: ORG_A, userId: MEMBER },
    { organizationId: ORG_B, userId: OTHER_ORG_USER },
  ];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("notify.member: recipient membership is checked at execution", () => {
  it("a current member of the workflow's org is notified, once", async () => {
    workflowWithSteps([notifyStep(MEMBER)]);
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(state.notifications).toEqual([
      expect.objectContaining({
        organizationId: ORG_A,
        userId: MEMBER,
        type: "workflow.notification",
      }),
    ]);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(state.memberLookups).toEqual([
      { organizationId: ORG_A, userId: MEMBER, organization: { deletedAt: null } },
    ]);
  });

  it("the default recipient (the creator) is notified while still a member", async () => {
    workflowWithSteps([notifyStep()]);
    await deliver();
    expect(state.notifications).toEqual([expect.objectContaining({ userId: CREATOR })]);
  });

  it("a member removed after the workflow was saved gets nothing; the run still succeeds", async () => {
    workflowWithSteps([notifyStep(MEMBER)]);
    state.memberships = state.memberships.filter((m) => m.userId !== MEMBER);
    const res = await deliver();
    expect(res.status).toBe(200);
    expect(state.notifications).toEqual([]);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(state.runs[0]!.stepResults).toEqual([
      { stepId: "s1", status: "skipped", output: { skipped: "recipient_not_member" } },
    ]);
    expect(state.steps[0]).toMatchObject({
      status: "SUCCEEDED",
      output: { skipped: "recipient_not_member" },
    });
  });

  it("a removed creator (default recipient) gets nothing", async () => {
    workflowWithSteps([notifyStep()]);
    state.memberships = state.memberships.filter((m) => m.userId !== CREATOR);
    await deliver();
    expect(state.notifications).toEqual([]);
  });

  it("a user of another organization is never notified in this one", async () => {
    workflowWithSteps([notifyStep(OTHER_ORG_USER)]);
    await deliver();
    expect(state.notifications).toEqual([]);
    // Looked up only within the workflow's own organization.
    expect(state.memberLookups).toEqual([
      expect.objectContaining({ organizationId: ORG_A, userId: OTHER_ORG_USER }),
    ]);
  });

  it("a redelivered event after a skip doesn't notify or re-run the step", async () => {
    workflowWithSteps([notifyStep(MEMBER)]);
    state.memberships = state.memberships.filter((m) => m.userId !== MEMBER);
    await deliver();
    // Re-added later; the same event delivered again is a duplicate.
    state.memberships.push({ organizationId: ORG_A, userId: MEMBER });
    const again = await deliver();
    expect(await again.json()).toMatchObject({ skipped: "duplicate_trigger" });
    expect(state.notifications).toEqual([]);
  });

  it("existing retry behavior: a failed membership read fails the step (500); the retry delivers once", async () => {
    workflowWithSteps([notifyStep(MEMBER)]);
    state.failMembershipLookups = 1;
    const first = await deliver();
    expect(first.status).toBe(500);
    expect(state.runs[0]).toMatchObject({ status: "FAILED" });
    expect(state.steps[0]).toMatchObject({ status: "FAILED" });
    expect(state.notifications.filter((n) => n.type === "workflow.notification")).toEqual([]);

    const retry = await deliver();
    expect(retry.status).toBe(200);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(state.notifications.filter((n) => n.type === "workflow.notification")).toEqual([
      expect.objectContaining({ userId: MEMBER }),
    ]);
  });
});

describe("workflow.failed: the creator is told only while still a member", () => {
  it("a current creator gets the failure notice; the 500 (QStash retry) is unchanged", async () => {
    workflowWithSteps([failingStep]);
    const res = await deliver();
    expect(res.status).toBe(500);
    expect(state.notifications).toEqual([
      expect.objectContaining({ organizationId: ORG_A, userId: CREATOR, type: "workflow.failed" }),
    ]);
  });

  it("a creator who left gets nothing; the run is still FAILED with a 500", async () => {
    workflowWithSteps([failingStep]);
    state.memberships = state.memberships.filter((m) => m.userId !== CREATOR);
    const res = await deliver();
    expect(res.status).toBe(500);
    expect(state.runs[0]).toMatchObject({ status: "FAILED" });
    expect(state.notifications).toEqual([]);
  });
});

describe("unavailable or deleted organizations", () => {
  it("existing behavior: a workflow that is gone (or in another org) is skipped with no notification", async () => {
    workflowWithSteps([notifyStep(MEMBER)]);
    const otherOrg = await deliver({ orgId: ORG_B });
    expect(await otherOrg.json()).toEqual({ skipped: "workflow inactive or gone" });
    state.workflow = null;
    const gone = await deliver();
    expect(await gone.json()).toEqual({ skipped: "workflow inactive or gone" });
    expect(state.runs).toEqual([]);
    expect(state.notifications).toEqual([]);
  });

  it("a soft-deleted organization's members get no notification or failure notice", async () => {
    state.deletedOrgs.add(ORG_A);
    workflowWithSteps([notifyStep(MEMBER)]);
    await deliver();
    workflowWithSteps([failingStep]);
    await deliver({ sourceEventKey: "deal.won:d2" });
    expect(state.notifications).toEqual([]);
  });
});
