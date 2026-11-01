import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staging, 2026-11-01: a test run of "Contact created → Create CRM activity
 * (contact field trigger.contactId)" failed with "step failed
 * (DriverAdapterError)". A test run's trigger data is only
 * { test, triggeredBy }, so the contact field resolved to "" and the contact
 * lookup sent "" as a uuid, which Postgres rejects (22P02) before the
 * "contact not found" check could run. The fake contact table below throws
 * exactly that way for a non-UUID id.
 */
class FakePrismaKnownError extends Error {
  constructor(readonly code: string) {
    super(`Prisma error ${code}`);
  }
}
class DriverAdapterError extends Error {
  constructor() {
    super('invalid input syntax for type uuid: ""');
    this.name = "DriverAdapterError";
  }
}

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const OTHER_ORG_CONTACT = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const TEST_RUN = "44444444-4444-4444-8444-444444444444";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  workflow: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
  steps: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<{ id: string; organizationId: string }>,
  activities: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  contactLookups: 0,
  /** Step executions started: a create, or a reclaim of a FAILED/stale step. */
  stepClaims: 0,
  /** Makes the next notification insert fail, like a database error. */
  failNextNotification: false,
  /** The next transaction commits, then reports an error (connection lost after COMMIT). */
  errorAfterNextCommit: false,
}));

/**
 * Evaluates a Prisma where clause the way the database would for the operators
 * the job uses, so the claim and reclaim conditions are actually exercised.
 */
function fieldMatches(value: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  if (condition === null || typeof condition !== "object") return value === condition;
  return Object.entries(condition as Row).every(([op, arg]) => {
    switch (op) {
      case "in":
        return (arg as unknown[]).includes(value);
      case "startsWith":
        return typeof value === "string" && value.startsWith(arg as string);
      case "lt":
        return value instanceof Date && value < (arg as Date);
      case "not":
        return arg === null ? value != null : !fieldMatches(value, arg);
      default:
        throw new Error(`fake where: unsupported operator ${op}`);
    }
  });
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    if (k === "AND") return (v as Row[]).every((w) => matches(row, w));
    if (k === "NOT") return !([v].flat() as Row[]).some((w) => matches(row, w));
    return fieldMatches(row[k], v);
  });
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
      const hits = state.runs.filter((r) => matches(r, where));
      for (const run of hits) Object.assign(run, data);
      return { count: hits.length };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find((r) => matches(r, where));
      if (!run) throw new FakePrismaKnownError("P2025");
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
      state.stepClaims += 1;
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
      if (data.status === "CLAIMED") state.stepClaims += 1;
      Object.assign(step, data);
      return { count: 1 };
    }),
  },
  contact: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => {
      state.contactLookups += 1;
      // Postgres casts the parameter to uuid: a non-UUID is a driver error.
      if (!UUID.test(where.id)) throw new DriverAdapterError();
      return state.contacts.find((c) => matches(c, where)) ?? null;
    }),
  },
  activity: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      state.activities.push(data);
      return data;
    }),
  },
  organization: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
  },
  organizationMember: {
    findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
      where.userId === CREATOR ? { id: "m1" } : null,
    ),
  },
  notification: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.failNextNotification) {
        state.failNextNotification = false;
        throw new FakePrismaKnownError("P2003");
      }
      state.notifications.push(data);
      return data;
    }),
  },
  // All or nothing, like the database: a throw rolls back runs and notifications.
  $transaction: async (fn: (tx: unknown) => unknown) => {
    const runs = structuredClone(state.runs);
    const notifications = structuredClone(state.notifications);
    try {
      const result = await fn(db);
      if (state.errorAfterNextCommit) {
        state.errorAfterNextCommit = false;
        throw Object.assign(new Error("connection lost after commit"), { committed: true });
      }
      return result;
    } catch (err) {
      if ((err as { committed?: boolean }).committed) throw err; // committed: nothing to undo
      state.runs.forEach((run, i) => Object.assign(run, runs[i]));
      state.notifications.splice(0, Infinity, ...notifications);
      throw err;
    }
  },
};

// The pilot organization: internal-only scope on (crm.create_activity is allowed).
vi.mock("@/server/services/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
  isRestrictionSet: vi.fn(async () => true),
}));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (req: Request) => req.text() }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: vi.fn(async () => undefined),
  getEntitlements: async () => ({ readOnly: false, activeWorkflows: 1 }),
}));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: async () => undefined,
  AiSpendError: class extends Error {},
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

import "@/server/jobs/organization-guard";
import { POST } from "@/app/api/v1/jobs/run-workflow/route";
import {
  CONTACT_MISSING_ERROR,
  CONTACT_MISSING_TEST_RUN_ERROR,
  CONTACT_NOT_FOUND_ERROR,
  isTerminalRunError,
  TERMINAL_RUN_ERRORS,
  workflowRunFailure,
} from "@/lib/workflows/run-failure";

function deliver(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      headers,
      body: JSON.stringify({ workflowId: WORKFLOW, orgId: ORG, ...payload }),
    }),
  );
}

/** What testWorkflowAction creates and enqueues. */
async function testRun() {
  const triggerData = { test: true, triggeredBy: CREATOR };
  state.runs.push({
    id: TEST_RUN,
    workflowId: WORKFLOW,
    organizationId: ORG,
    triggerData,
    status: "RUNNING",
    stepResults: [],
    startedAt: new Date(),
  });
  return deliver({ triggerType: "manual", triggerData, runId: TEST_RUN, resumeFromIndex: 0 });
}

/** What emitWorkflowEvent enqueues for a new contact (contacts.ts). */
function contactCreated(contactId: string) {
  return deliver({
    triggerType: "contact.created",
    triggerData: { contactId, firstName: "Pilot", lastName: "Guest" },
    sourceEventKey: `contact.created:${contactId}`,
  });
}

beforeEach(() => {
  state.workflow = {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Pilot contact workflow test",
    isActive: true,
    createdById: CREATOR,
    trigger: { type: "contact.created" },
    steps: [
      {
        id: "s1",
        type: "crm.create_activity",
        contactIdVar: "trigger.contactId",
        activityType: "TASK",
        subject: "Pilot workflow activity test",
      },
    ],
  };
  state.runs = [];
  state.steps = [];
  state.contacts = [
    { id: CONTACT, organizationId: ORG },
    { id: OTHER_ORG_CONTACT, organizationId: OTHER_ORG },
  ];
  state.activities = [];
  state.notifications = [];
  state.contactLookups = 0;
  state.stepClaims = 0;
  state.failNextNotification = false;
  state.errorAfterNextCommit = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("crm.create_activity: contact field resolution", () => {
  it("a test run (no contact in its trigger data) fails with a reason, not a driver error", async () => {
    const res = await testRun();
    // Deterministic: ends the job (no QStash retry) and tells the creator
    // now, on the first attempt, instead of after three identical failures.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ failed: true });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      type: "workflow.failed",
      body: CONTACT_MISSING_TEST_RUN_ERROR,
    });
    expect(state.contactLookups).toBe(0);
    expect(state.activities).toEqual([]);
    const run = state.runs[0]!;
    expect(run).toMatchObject({ status: "FAILED", error: CONTACT_MISSING_TEST_RUN_ERROR });
    expect(workflowRunFailure(run.error as string)).toBe("contact_missing_test_run");
    expect(state.steps[0]).toMatchObject({
      status: "FAILED",
      error: CONTACT_MISSING_TEST_RUN_ERROR,
    });
  });

  it("a redelivered failed test run stays FAILED and creates nothing", async () => {
    await testRun();
    const res = await deliver({
      triggerType: "manual",
      triggerData: { test: true, triggeredBy: CREATOR },
      runId: TEST_RUN,
      resumeFromIndex: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "terminal_failure" });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      status: "FAILED",
      error: CONTACT_MISSING_TEST_RUN_ERROR,
    });
    expect(state.activities).toEqual([]);
    expect(state.contactLookups).toBe(0);
    // The step ran once, and the creator was told once.
    expect(state.stepClaims).toBe(1);
    expect(state.notifications).toHaveLength(1);
  });

  it("the same terminal event delivered twice (same sourceEventKey) stays FAILED, runs once, notifies once", async () => {
    const UNKNOWN = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
    const event = {
      triggerType: "contact.created",
      triggerData: { contactId: UNKNOWN },
      sourceEventKey: `contact.created:${UNKNOWN}`,
    };
    const first = await deliver(event, { "upstash-retried": "0" });
    expect(first.status).toBe(200);
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });

    const again = await deliver(event, { "upstash-retried": "0" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });
    expect(state.contactLookups).toBe(1);
    expect(state.stepClaims).toBe(1);
    expect(state.steps[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });
    expect(state.notifications).toHaveLength(1);
    expect(state.activities).toEqual([]);
  });

  it("a terminal failure whose notification can't be written stays retryable, then notifies once", async () => {
    const UNKNOWN = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
    const event = {
      triggerType: "contact.created",
      triggerData: { contactId: UNKNOWN },
      sourceEventKey: `contact.created:${UNKNOWN}`,
    };
    state.failNextNotification = true;
    const first = await deliver(event, { "upstash-retried": "0" });
    // Neither the terminal state nor the notification was recorded together,
    // so the run is left retryable and the delivery asks for a retry.
    expect(first.status).toBe(500);
    expect(state.notifications).toEqual([]);
    expect(state.runs[0]!.status).toBe("FAILED");
    expect(isTerminalRunError(state.runs[0]!.error as string)).toBe(false);
    expect(state.runs[0]!.error).toBe("failure not recorded (Error)");

    const retry = await deliver(event, { "upstash-retried": "1" });
    expect(retry.status).toBe(200);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });
    expect(state.stepClaims).toBe(2);
    expect(state.notifications).toHaveLength(1);

    // And from now on it is terminal.
    const again = await deliver(event, { "upstash-retried": "0" });
    expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    expect(state.stepClaims).toBe(2);
    expect(state.notifications).toHaveLength(1);
  });

  it("a failure record that committed but reported an error is not overwritten (no second notification)", async () => {
    const UNKNOWN = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
    const event = {
      triggerType: "contact.created",
      triggerData: { contactId: UNKNOWN },
      sourceEventKey: `contact.created:${UNKNOWN}`,
    };
    // The contact lookup fails before any step transaction, so the next
    // transaction is the failure record: it commits, then reports an error.
    state.errorAfterNextCommit = true;
    const first = await deliver(event, { "upstash-retried": "0" });
    expect(first.status).toBe(500);
    // The committed terminal record stands: the fallback only touches a RUNNING run.
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });
    expect(state.notifications).toHaveLength(1);

    const again = await deliver(event, { "upstash-retried": "1" });
    expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    expect(state.notifications).toHaveLength(1);
    expect(state.stepClaims).toBe(1);
  });

  it("a crashed run with no recorded error is reclaimed by redelivery", async () => {
    const event = {
      triggerType: "contact.created",
      triggerData: { contactId: CONTACT },
      sourceEventKey: `contact.created:${CONTACT}`,
    };
    state.runs.push({
      id: "run-crashed",
      workflowId: WORKFLOW,
      organizationId: ORG,
      triggerData: event.triggerData,
      status: "FAILED",
      error: null,
      stepResults: [],
      startedAt: new Date(),
      sourceEventKey: event.sourceEventKey,
    });
    const res = await deliver(event, { "upstash-retried": "1" });
    expect(res.status).toBe(200);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ id: "run-crashed", status: "SUCCEEDED" });
    expect(state.activities).toHaveLength(1);
  });

  it("a runId of another workflow's run is never resumed, even if retryable", async () => {
    state.runs.push({
      id: TEST_RUN,
      workflowId: "99999999-9999-4999-8999-999999999999",
      organizationId: ORG,
      triggerData: { contactId: CONTACT },
      status: "FAILED",
      error: null,
      stepResults: [],
      startedAt: new Date(),
    });
    const res = await deliver({
      triggerType: "manual",
      triggerData: { contactId: CONTACT },
      runId: TEST_RUN,
      resumeFromIndex: 0,
    });
    expect(await res.json()).toEqual({ skipped: "run not found for workflow" });
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: null });
    expect(state.stepClaims).toBe(0);
    expect(state.activities).toEqual([]);
  });

  it("a transient failure is still retried by redelivery and then succeeds once", async () => {
    const event = {
      triggerType: "contact.created",
      triggerData: { contactId: CONTACT },
      sourceEventKey: `contact.created:${CONTACT}`,
    };
    const contacts = state.contacts;
    state.contacts = null as never; // the lookup fails: a database error, not a step error
    const first = await deliver(event, { "upstash-retried": "0" });
    expect(first.status).toBe(500);
    expect(state.runs[0]).toMatchObject({ status: "FAILED" });
    expect(workflowRunFailure(state.runs[0]!.error as string)).toBe("internal");

    state.contacts = contacts; // the database is back
    const retry = await deliver(event, { "upstash-retried": "1" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(state.activities).toHaveLength(1);
    expect(state.stepClaims).toBe(2); // first attempt + the reclaim
    expect(state.notifications).toEqual([]);
  });

  it("a transient failure of a manual run with runId is still resumable", async () => {
    const triggerData = { contactId: CONTACT, triggeredBy: CREATOR };
    state.runs.push({
      id: TEST_RUN,
      workflowId: WORKFLOW,
      organizationId: ORG,
      triggerData,
      status: "RUNNING",
      stepResults: [],
      startedAt: new Date(),
      error: null,
    });
    const payload = { triggerType: "manual", triggerData, runId: TEST_RUN, resumeFromIndex: 0 };
    const contacts = state.contacts;
    state.contacts = null as never;
    expect((await deliver(payload, { "upstash-retried": "0" })).status).toBe(500);
    expect(state.runs[0]).toMatchObject({ status: "FAILED" });

    state.contacts = contacts;
    const retry = await deliver(payload, { "upstash-retried": "1" });
    expect(retry.status).toBe(200);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(state.activities).toHaveLength(1);
    expect(state.notifications).toEqual([]);
  });

  it("a step error on a first attempt (QStash would retry) ends the job and notifies once", async () => {
    const res = await deliver(
      {
        triggerType: "deal.won",
        triggerData: { dealId: "deal-1", title: "Pilot deal", valueCents: 100000 },
        sourceEventKey: "deal.won:deal-1",
      },
      { "upstash-retried": "0" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: CONTACT_MISSING_ERROR, failed: true });
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_MISSING_ERROR });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({ type: "workflow.failed" });
  });

  it("an unexpected error on a first attempt still returns 500 for a retry, without notifying", async () => {
    // The contact lookup itself fails (a database error, not a step error).
    state.contacts = null as never;
    const res = await deliver(
      {
        triggerType: "contact.created",
        triggerData: { contactId: CONTACT },
        sourceEventKey: `contact.created:${CONTACT}`,
      },
      { "upstash-retried": "0" },
    );
    expect(res.status).toBe(500);
    expect(state.notifications).toEqual([]);
    expect(state.runs[0]).toMatchObject({ status: "FAILED" });
    expect(workflowRunFailure(state.runs[0]!.error as string)).toBe("internal");
  });

  it("a live trigger without a contact (deal.won) gets the general reason, not the test-run one", async () => {
    await deliver({
      triggerType: "deal.won",
      triggerData: { dealId: "deal-1", title: "Pilot deal", valueCents: 100000 },
      sourceEventKey: "deal.won:deal-1",
    });
    expect(state.contactLookups).toBe(0);
    expect(state.activities).toEqual([]);
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_MISSING_ERROR });
    expect(workflowRunFailure(state.runs[0]!.error as string)).toBe("contact_missing");
  });

  it.each([["not-a-uuid"], [42]])(
    "a contact field that isn't a UUID (%s) is 'contact not found', never queried",
    async (contactId) => {
      await contactCreated(contactId as string);
      expect(state.contactLookups).toBe(0);
      expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });
      expect(workflowRunFailure(state.runs[0]!.error as string)).toBe("contact_not_found");
    },
  );

  it("another organization's contact is not found and gets no activity", async () => {
    await contactCreated(OTHER_ORG_CONTACT);
    expect(state.runs[0]).toMatchObject({ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR });
    expect(state.activities).toEqual([]);
  });

  it("a new contact gets exactly one activity, also when the event is delivered again", async () => {
    expect((await contactCreated(CONTACT)).status).toBe(200);
    expect((await contactCreated(CONTACT)).status).toBe(200);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(state.activities).toEqual([
      {
        organizationId: ORG,
        contactId: CONTACT,
        type: "TASK",
        subject: "Pilot workflow activity test",
        body: undefined,
        metadata: { via: "workflow", workflowId: WORKFLOW },
      },
    ]);
  });
});

describe("workflowRunFailure", () => {
  it.each([
    [null, null],
    [CONTACT_MISSING_TEST_RUN_ERROR, "contact_missing_test_run"],
    [CONTACT_MISSING_ERROR, "contact_missing"],
    [CONTACT_NOT_FOUND_ERROR, "contact_not_found"],
    ['email.send: invalid recipient "x"', "invalid_recipient"],
    ["ai_quota_exceeded", "ai_quota_exceeded"],
    ["step_not_allowed", "step_not_allowed"],
    ["workflow_deactivated", "workflow_deactivated"],
    // The staging run's stored text, and any other internal error.
    ["step failed (DriverAdapterError)", "internal"],
    ["ai.generate failed (AuthenticationError)", "internal"],
  ])("%s → %s", (stored, code) => {
    expect(workflowRunFailure(stored)).toBe(code);
  });
});

describe("isTerminalRunError", () => {
  it.each([
    [CONTACT_MISSING_TEST_RUN_ERROR, true],
    [CONTACT_MISSING_ERROR, true],
    [CONTACT_NOT_FOUND_ERROR, true],
    ['email.send: invalid recipient "x"', true],
    ["ai_quota_exceeded", true],
    // Retryable: crashes, provider or database errors, legacy rows, and a
    // failure record that itself could not be written.
    [null, false],
    ["", false],
    ["step failed (DriverAdapterError)", false],
    ["email.send failed (EmailSendError)", false],
    ["failure not recorded (PrismaClientKnownRequestError)", false],
    ["step_not_allowed", false],
  ])("%s → %s", (stored, terminal) => {
    expect(isTerminalRunError(stored)).toBe(terminal);
  });

  it("every terminal error has its own translated reason, never 'internal'", () => {
    for (const error of [...TERMINAL_RUN_ERRORS.exact, 'email.send: invalid recipient "x"']) {
      expect(workflowRunFailure(error)).not.toBe("internal");
    }
  });
});
