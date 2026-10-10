import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A workflow test run enqueues the workflow directly, bypassing isActive and the active-workflow
 * limit. Its steps can call an AI provider and send email from the platform domain, so the
 * action must require a plan that includes workflows and be rate-limited per organization.
 */
const m = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1" })),
  getEntitlements: vi.fn(async () => ({ readOnly: false, activeWorkflows: 5 })),
  checkRateLimit: vi.fn(async (_name: string, _key: string) => ({
    ok: true as boolean,
    reason: undefined as string | undefined,
  })),
  workflowFindFirstOrThrow: vi.fn(async () => ({ id: "wf-1" })),
  workflowRunCreate: vi.fn(async () => ({ id: "run-1" })),
  enqueue: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: m.requirePermission }));
vi.mock("@/server/services/workflows", () => ({
  upsertWorkflow: vi.fn(),
  setWorkflowActive: vi.fn(),
  WorkflowError: class extends Error {},
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class extends Error {},
  getEntitlements: m.getEntitlements,
}));
vi.mock("@/server/integrations/redis", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    workflow: { findFirstOrThrow: m.workflowFindFirstOrThrow },
    workflowRun: { create: m.workflowRunCreate },
  },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));

import { testWorkflowAction } from "@/actions/workflows";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("testWorkflowAction", () => {
  it("runs the workflow for an entitled organization within the limit", async () => {
    expect(await testWorkflowAction("wf-1")).toEqual({ message: "test_started" });
    expect(m.checkRateLimit).toHaveBeenCalledWith("workflowTestRun", "org-a");
    expect(m.workflowFindFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "wf-1", organizationId: "org-a" },
    });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses a plan without workflows before creating or enqueueing a run", async () => {
    m.getEntitlements.mockResolvedValueOnce({ readOnly: false, activeWorkflows: 0 });
    expect(await testWorkflowAction("wf-1")).toEqual({ error: "quota" });
    expect(m.checkRateLimit).not.toHaveBeenCalled();
    expect(m.workflowRunCreate).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a read-only (past-due) workspace", async () => {
    m.getEntitlements.mockResolvedValueOnce({ readOnly: true, activeWorkflows: 5 });
    expect(await testWorkflowAction("wf-1")).toEqual({ error: "quota" });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses once the organization's test-run limit is reached", async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ok: false, reason: "limited" });
    expect(await testWorkflowAction("wf-1")).toEqual({ error: "rate_limited" });
    expect(m.workflowRunCreate).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses when the test-run limit can't be verified", async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    expect(await testWorkflowAction("wf-1")).toEqual({ error: "service_unavailable" });
    expect(m.workflowRunCreate).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});
