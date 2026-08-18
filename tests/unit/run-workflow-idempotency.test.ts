import { beforeEach, describe, expect, it, vi } from "vitest";

class FakePrismaKnownError extends Error {
  code: string;
  constructor(code: string) {
    super(`Prisma error ${code}`);
    this.code = code;
  }
}

const mocks = vi.hoisted(() => {
  return {
    verifyJobRequest: vi.fn(async (req: Request) => req.text()),
    workflowFindFirst: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
    runCreate: vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>),
    runUpdate: vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>),
    runUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    runFindFirst: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
    runFindFirstOrThrow: vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>),
    // Step-execution ledger (src/app/api/v1/jobs/run-workflow/route.ts's
    // claimStep/completeStep). Defaulted in beforeEach so every existing
    // trigger-level test below (none of which exercise step-level replay
    // itself - see run-workflow-step-idempotency.test.ts for that) claims
    // fresh and completes normally, same as before this ledger existed.
    stepExecCreate: vi.fn(async (_args: unknown) => ({ id: "step-exec-1", startedAt: new Date() })),
    stepExecUpdate: vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>),
    stepExecUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    stepExecFindFirst: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
    stepExecFindFirstOrThrow: vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>),
    contactFindFirst: vi.fn(async (_args: unknown) => ({ id: "contact-1" })),
    activityCreate: vi.fn(async (_args: unknown) => ({})),
    notificationCreate: vi.fn(async (_args: unknown) => ({})),
    enqueue: vi.fn(async (..._args: unknown[]) => undefined),
    anthropicCreate: vi.fn(async (_args: unknown) => ({
      content: [{ type: "text", text: "ai output" }],
      usage: { output_tokens: 10 },
    })),
    sendEmail: vi.fn(async (_args: unknown) => undefined),
    recordUsage: vi.fn(async (..._args: unknown[]) => undefined),
  };
});

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    workflow: { findFirst: mocks.workflowFindFirst },
    workflowRun: {
      create: mocks.runCreate,
      update: mocks.runUpdate,
      updateMany: mocks.runUpdateMany,
      findFirst: mocks.runFindFirst,
      findFirstOrThrow: mocks.runFindFirstOrThrow,
    },
    workflowStepExecution: {
      create: mocks.stepExecCreate,
      update: mocks.stepExecUpdate,
      updateMany: mocks.stepExecUpdateMany,
      findFirst: mocks.stepExecFindFirst,
      findFirstOrThrow: mocks.stepExecFindFirstOrThrow,
    },
    contact: { findFirst: mocks.contactFindFirst },
    activity: { create: mocks.activityCreate },
    notification: { create: mocks.notificationCreate },
    // DB-local steps (crm.create_activity/notify.member) run their side
    // effect + step-completion update in one transaction; the same mocked
    // methods work fine as the `tx` client here since none of these tests
    // assert transactional atomicity itself (see
    // run-workflow-step-idempotency.test.ts for that).
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        activity: { create: mocks.activityCreate },
        notification: { create: mocks.notificationCreate },
        workflowStepExecution: {
          update: mocks.stepExecUpdate,
          updateMany: mocks.stepExecUpdateMany,
        },
      }),
    ),
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
    triggerType: "booking.created",
    triggerData: { bookingId: "bk-1" },
    sourceEventKey: "booking.created:bk-1",
    ...overrides,
  };
}

function activeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Notify on booking",
    isActive: true,
    createdById: "user-1",
    steps: [{ id: "s1", type: "notify.member", title: "New booking" }],
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    workflowId: WORKFLOW,
    organizationId: ORG,
    status: "RUNNING",
    triggerData: {},
    stepResults: [],
    startedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyJobRequest.mockImplementation(async (req: Request) => req.text());
  mocks.workflowFindFirst.mockResolvedValue(activeWorkflow());
  mocks.runCreate.mockImplementation(async (rawArgs: unknown) => {
    const args = rawArgs as { data: Record<string, unknown> };
    return runRow({ id: "run-1", ...args.data });
  });
  mocks.runUpdate.mockResolvedValue(runRow());
  mocks.runUpdateMany.mockResolvedValue({ count: 1 });
  mocks.runFindFirst.mockResolvedValue(null);
  mocks.runFindFirstOrThrow.mockResolvedValue(runRow());
  mocks.contactFindFirst.mockResolvedValue({ id: "contact-1" });
});

async function post(body: Record<string, unknown>) {
  return POST(jobRequest(body));
}

describe("trigger-level idempotency: sequential duplicate delivery", () => {
  it("first delivery claims and runs the workflow; second identical delivery is suppressed as a duplicate", async () => {
    const first = await post(freshTriggerPayload());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);

    // Second delivery of the exact same source event: create() now collides
    // (simulating the real unique constraint), and the existing row is
    // already SUCCEEDED (the first attempt completed above).
    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(runRow({ status: "SUCCEEDED" }));

    const second = await post(freshTriggerPayload());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ skipped: "duplicate_trigger", duplicate: true });
    // No second execution of the side effect.
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    expect(mocks.runUpdateMany).not.toHaveBeenCalled();
  });
});

describe("trigger-level idempotency: concurrent duplicate delivery", () => {
  it("returns a safe duplicate response when the claim loses to an in-flight (non-stale) RUNNING row", async () => {
    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(runRow({ status: "RUNNING", startedAt: new Date() }));

    const res = await post(freshTriggerPayload());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "duplicate_trigger", duplicate: false });
    expect(mocks.runUpdateMany).not.toHaveBeenCalled();
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it("returns a safe duplicate response when the atomic reclaim loses the race (count: 0)", async () => {
    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(runRow({ status: "FAILED" }));
    mocks.runUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await post(freshTriggerPayload());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "duplicate_trigger", duplicate: false });
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });
});

describe("trigger-level idempotency: retry after FAILED", () => {
  it("reclaims a FAILED run and executes it (preserves QStash's existing retry-on-failure behavior)", async () => {
    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(runRow({ status: "FAILED" }));
    mocks.runUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.runFindFirstOrThrow.mockResolvedValueOnce(runRow({ status: "RUNNING", stepResults: [] }));

    const res = await post(freshTriggerPayload());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.runUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          workflowId: WORKFLOW,
          sourceEventKey: "booking.created:bk-1",
          OR: [{ status: "FAILED" }, { status: "RUNNING", startedAt: { lt: expect.any(Date) } }],
        }),
        data: expect.objectContaining({ status: "RUNNING" }),
      }),
    );
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
  });
});

describe("trigger-level idempotency: stale RUNNING reclaim (inferred crash)", () => {
  it("reclaims a RUNNING row older than the staleness window and executes it", async () => {
    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(
      runRow({ status: "RUNNING", startedAt: new Date(Date.now() - 10 * 60_000) }), // 10 min old
    );
    mocks.runUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.runFindFirstOrThrow.mockResolvedValueOnce(runRow({ status: "RUNNING", stepResults: [] }));

    const res = await post(freshTriggerPayload());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.runUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("trigger-level idempotency: WAITING is never reclaimed regardless of age", () => {
  it("treats a long-WAITING run (mid wait.duration step) as in-flight, not stale/crashed", async () => {
    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(
      runRow({ status: "WAITING", startedAt: new Date(Date.now() - 24 * 60 * 60_000) }), // 1 day
    );

    const res = await post(freshTriggerPayload());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "duplicate_trigger", duplicate: false });
    // WAITING is never a reclaim candidate - the guarded updateMany must not
    // even be attempted, regardless of how long the wait has been running.
    expect(mocks.runUpdateMany).not.toHaveBeenCalled();
  });
});

describe("trigger-level idempotency: genuinely distinct events are never suppressed", () => {
  it("a different sourceEventKey on the same workflow always claims and runs, even right after another event's duplicate", async () => {
    await post(freshTriggerPayload({ sourceEventKey: "booking.created:bk-1" }));
    const second = await post(
      freshTriggerPayload({
        sourceEventKey: "booking.created:bk-2",
        triggerData: { bookingId: "bk-2" },
      }),
    );

    expect(await second.json()).toEqual({ ok: true });
    expect(mocks.runCreate).toHaveBeenCalledTimes(2);
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(2);
  });
});

describe("trigger-level idempotency: cross-tenant independence", () => {
  it("the same sourceEventKey in two different orgs claims and runs independently in both", async () => {
    const otherOrg = "99999999-9999-4999-8999-999999999999";
    mocks.workflowFindFirst.mockResolvedValue(activeWorkflow());

    const first = await post(freshTriggerPayload({ orgId: ORG }));
    const second = await post(freshTriggerPayload({ orgId: otherOrg }));

    expect(await first.json()).toEqual({ ok: true });
    expect(await second.json()).toEqual({ ok: true });
    expect(mocks.runCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG }) }),
    );
    expect(mocks.runCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ organizationId: otherOrg }) }),
    );
  });
});

describe("trigger-level idempotency: multiple workflows subscribed to the same event", () => {
  it("the same sourceEventKey against two different workflowIds claims and runs both", async () => {
    const otherWorkflow = "33333333-3333-4333-8333-333333333333";
    mocks.workflowFindFirst.mockImplementation(async (rawArgs: unknown) => {
      const args = rawArgs as { where: { id: string } };
      return activeWorkflow({ id: args.where.id });
    });

    const first = await post(freshTriggerPayload({ workflowId: WORKFLOW }));
    const second = await post(freshTriggerPayload({ workflowId: otherWorkflow }));

    expect(await first.json()).toEqual({ ok: true });
    expect(await second.json()).toEqual({ ok: true });
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(2);
  });
});

describe("trigger-level idempotency: fail-closed on missing identity", () => {
  it("rejects a fresh trigger (no runId) that carries no sourceEventKey", async () => {
    const payload: Record<string, unknown> = freshTriggerPayload();
    delete payload.sourceEventKey;
    const res = await post(payload);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing sourceEventKey for fresh trigger" });
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });
});

describe("trigger-level idempotency: resumes are unaffected by the claim path", () => {
  it("a wait.duration resume (runId present, no sourceEventKey) always proceeds via update(), never through claim/create", async () => {
    mocks.workflowFindFirst.mockResolvedValue(
      activeWorkflow({ steps: [{ id: "s1", type: "notify.member", title: "Resumed" }] }),
    );
    const runId = "44444444-4444-4444-8444-444444444444";
    mocks.runUpdate.mockResolvedValueOnce(runRow({ id: runId, stepResults: [] }));

    const res = await post({
      workflowId: WORKFLOW,
      orgId: ORG,
      triggerType: "booking.created",
      triggerData: {},
      runId,
      resumeFromIndex: 0,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.runCreate).not.toHaveBeenCalled();
    expect(mocks.runUpdate).toHaveBeenCalledWith({
      where: { id: runId },
      data: { status: "RUNNING" },
    });
  });
});

describe("trigger-level idempotency: representative side-effect proof", () => {
  it("crm.create_activity runs exactly once across a duplicate delivery pair", async () => {
    mocks.workflowFindFirst.mockResolvedValue(
      activeWorkflow({
        steps: [
          {
            id: "s1",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "MEETING",
            subject: "Booked",
          },
        ],
      }),
    );

    await post(freshTriggerPayload({ triggerData: { contactId: "contact-1" } }));
    expect(mocks.activityCreate).toHaveBeenCalledTimes(1);

    mocks.runCreate.mockRejectedValueOnce(new FakePrismaKnownError("P2002"));
    mocks.runFindFirst.mockResolvedValueOnce(runRow({ status: "SUCCEEDED" }));
    await post(freshTriggerPayload({ triggerData: { contactId: "contact-1" } }));

    expect(mocks.activityCreate).toHaveBeenCalledTimes(1);
  });
});
