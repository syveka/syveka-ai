import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workflow server actions return stable error codes the UI can translate,
 * never raw validator text, and the activation entitlement check stays on the
 * server: toggleWorkflowAction always goes through setWorkflowActive (which
 * calls assertWithinLimit) and reports a refusal as "quota".
 */
const m = vi.hoisted(() => {
  class EntitlementError extends Error {}
  class WorkflowError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    EntitlementError,
    WorkflowError,
    requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1", role: "OWNER" })),
    upsertWorkflow: vi.fn(async () => ({ id: "wf-1" })),
    setWorkflowActive: vi.fn(async () => undefined),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: m.requirePermission }));
vi.mock("@/server/services/workflows", () => ({
  upsertWorkflow: m.upsertWorkflow,
  setWorkflowActive: m.setWorkflowActive,
  WorkflowError: m.WorkflowError,
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: m.EntitlementError,
  getEntitlements: vi.fn(),
}));
vi.mock("@/server/integrations/redis", () => ({ checkRateLimit: vi.fn() }));

import { saveWorkflowAction, toggleWorkflowAction } from "@/actions/workflows";

const valid = {
  name: "Welcome",
  trigger: { type: "contact.created" },
  steps: [{ id: "s1", type: "notify.member", title: "Hi" }],
};

beforeEach(() => vi.clearAllMocks());

describe("saveWorkflowAction error codes", () => {
  it("returns invalid_input instead of a raw validator message", async () => {
    const res = await saveWorkflowAction("wf-1", { ...valid, name: 42 });
    expect(res).toEqual({ error: "invalid_input" });
    expect(m.upsertWorkflow).not.toHaveBeenCalled();
  });

  it("returns duplicate_step_id for duplicated step ids", async () => {
    const step = { id: "s1", type: "notify.member", title: "Hi" };
    expect(await saveWorkflowAction("wf-1", { ...valid, steps: [step, step] })).toEqual({
      error: "duplicate_step_id",
    });
  });

  it("passes service error codes through", async () => {
    m.upsertWorkflow.mockRejectedValueOnce(new m.WorkflowError("x", "recipient_not_member"));
    expect(await saveWorkflowAction("wf-1", valid)).toEqual({ error: "recipient_not_member" });
  });

  it("still requires workflows:manage", async () => {
    await saveWorkflowAction("wf-1", valid);
    expect(m.requirePermission).toHaveBeenCalledWith("workflows:manage");
  });
});

describe("toggleWorkflowAction", () => {
  it("enforces entitlements on the server and reports a refusal as quota", async () => {
    m.setWorkflowActive.mockRejectedValueOnce(new m.EntitlementError("limit"));
    expect(await toggleWorkflowAction("wf-1", true)).toEqual({ error: "quota" });
    expect(m.requirePermission).toHaveBeenCalledWith("workflows:manage");
    expect(m.setWorkflowActive).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a" }),
      "wf-1",
      true,
    );
  });
});
