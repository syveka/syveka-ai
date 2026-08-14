import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  workflow: "11111111-1111-4111-8111-111111111111",
  org: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  creator: "44444444-4444-4444-8444-444444444444",
  recipient: "55555555-5555-4555-8555-555555555555",
};

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(),
  workflowFindFirst: vi.fn(),
  workflowRunFindFirst: vi.fn(),
  workflowRunCreate: vi.fn(),
  workflowRunUpdate: vi.fn(),
  memberFindFirst: vi.fn(),
  notificationCreate: vi.fn(),
  enqueue: vi.fn(),
  sendEmail: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    workflow: { findFirst: mocks.workflowFindFirst },
    workflowRun: {
      findFirst: mocks.workflowRunFindFirst,
      create: mocks.workflowRunCreate,
      update: mocks.workflowRunUpdate,
    },
    organizationMember: { findFirst: mocks.memberFindFirst },
    notification: { create: mocks.notificationCreate },
    contact: { findFirst: vi.fn() },
    activity: { create: vi.fn() },
  },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: vi.fn(() => ({ model: "test", maxTokens: 10 })),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: mocks.recordUsage }));

import { POST } from "@/app/api/v1/jobs/run-workflow/route";

function request() {
  return new Request("http://localhost/api/v1/jobs/run-workflow", { method: "POST" });
}

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    workflowId: ids.workflow,
    orgId: ids.org,
    triggerType: "manual",
    triggerData: {},
    ...overrides,
  });
}

function workflow(steps: unknown[]) {
  return {
    id: ids.workflow,
    organizationId: ids.org,
    name: "Workflow",
    isActive: true,
    createdById: ids.creator,
    steps,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyJobRequest.mockResolvedValue(payload());
  mocks.workflowFindFirst.mockResolvedValue(workflow([]));
  mocks.workflowRunCreate.mockResolvedValue({ id: ids.run, stepResults: [] });
  mocks.workflowRunUpdate.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: ids.run,
      stepResults: [],
      ...data,
    }),
  );
  mocks.recordUsage.mockResolvedValue(undefined);
});

describe("run-workflow tenant boundaries", () => {
  it("does not resume a run unless it belongs to both the workflow and organization", async () => {
    mocks.verifyJobRequest.mockResolvedValue(payload({ runId: ids.run, resumeFromIndex: 0 }));
    mocks.workflowRunFindFirst.mockResolvedValue(null);

    const response = await POST(request());
    await expect(response.json()).resolves.toEqual({ skipped: "workflow run not found" });
    expect(mocks.workflowRunFindFirst).toHaveBeenCalledWith({
      where: { id: ids.run, workflowId: ids.workflow, organizationId: ids.org },
    });
    expect(mocks.workflowRunUpdate).not.toHaveBeenCalled();
    expect(mocks.workflowRunCreate).not.toHaveBeenCalled();
  });

  it("skips a notification when the configured recipient is no longer a member", async () => {
    mocks.workflowFindFirst.mockResolvedValue(
      workflow([{ id: "notify", type: "notify.member", userId: ids.recipient, title: "Hello" }]),
    );
    mocks.memberFindFirst.mockResolvedValue(null);

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.memberFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ids.org,
        userId: ids.recipient,
        organization: { deletedAt: null },
      },
      select: { id: true },
    });
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
    expect(mocks.workflowRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stepResults: [expect.objectContaining({ stepId: "notify", status: "skipped" })],
        }),
      }),
    );
  });

  it("creates a notification for a current member in the active organization", async () => {
    mocks.workflowFindFirst.mockResolvedValue(
      workflow([{ id: "notify", type: "notify.member", userId: ids.recipient, title: "Hello" }]),
    );
    mocks.memberFindFirst.mockResolvedValue({ id: "membership-1" });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: ids.org, userId: ids.recipient }),
    });
  });

  it("does not write a failure notification after the workflow creator is revoked", async () => {
    mocks.workflowFindFirst.mockResolvedValue(
      workflow([{ id: "email", type: "email.send", to: "invalid", subject: "Test", body: "Body" }]),
    );
    mocks.memberFindFirst.mockResolvedValue(null);

    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.memberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: ids.creator, organizationId: ids.org }),
      }),
    );
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });
});
