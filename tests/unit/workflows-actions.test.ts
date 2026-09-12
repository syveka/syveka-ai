import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async (): Promise<TenantContext> => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "MANAGER",
    locale: "en",
  })),
  upsertWorkflow: vi.fn(async (_ctx: unknown, input: unknown, workflowId?: string) => ({
    id: workflowId ?? "new-workflow-1",
    ...(input as object),
  })),
  setWorkflowActive: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/workflows", () => ({
  upsertWorkflow: mocks.upsertWorkflow,
  setWorkflowActive: mocks.setWorkflowActive,
}));

import { saveWorkflowAction } from "@/actions/workflows";

function payload(steps: unknown[]) {
  return { name: "Test workflow", trigger: { type: "manual" }, steps };
}

const dupSteps = [
  {
    id: "s1",
    type: "crm.create_activity",
    contactIdVar: "trigger.contactId",
    activityType: "NOTE",
    subject: "A",
  },
  { id: "s1", type: "notify.member", title: "B" },
];

const validSteps = [
  {
    id: "s1",
    type: "crm.create_activity",
    contactIdVar: "trigger.contactId",
    activityType: "NOTE",
    subject: "A",
  },
  { id: "s2", type: "notify.member", title: "B" },
];

describe("saveWorkflowAction: step id uniqueness is enforced at the server trust boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create path: rejects a duplicate-step-id workflow before it reaches upsertWorkflow", async () => {
    const result = await saveWorkflowAction(undefined, payload(dupSteps));

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("duplicate");
    expect(mocks.upsertWorkflow).not.toHaveBeenCalled();
  });

  it("update path: rejects a duplicate-step-id workflow, leaving the existing stored workflow untouched", async () => {
    const result = await saveWorkflowAction("existing-workflow-1", payload(dupSteps));

    expect(result.error).toBeTruthy();
    expect(mocks.upsertWorkflow).not.toHaveBeenCalled();
  });

  it("create path: a valid, unique-id workflow passes through to upsertWorkflow normally", async () => {
    const result = await saveWorkflowAction(undefined, payload(validSteps));

    expect(result.error).toBeUndefined();
    expect(mocks.upsertWorkflow).toHaveBeenCalledTimes(1);
  });

  it("update path: a valid, unique-id workflow passes through to upsertWorkflow normally", async () => {
    const result = await saveWorkflowAction("existing-workflow-1", payload(validSteps));

    expect(result.error).toBeUndefined();
    expect(mocks.upsertWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.upsertWorkflow.mock.calls[0]![2]).toBe("existing-workflow-1");
  });
});
