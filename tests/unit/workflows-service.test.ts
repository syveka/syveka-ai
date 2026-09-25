import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberCount: vi.fn(),
  workflowCreate: vi.fn(),
  workflowUpdate: vi.fn(),
  workflowFindFirstOrThrow: vi.fn(),
  tenantDb: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({ tenantDb: mocks.tenantDb }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/server/services/billing/entitlements", () => ({ assertWithinLimit: vi.fn() }));

import { upsertWorkflow, WorkflowError } from "@/server/services/workflows";
import type { TenantContext } from "@/server/auth/session";
import type { WorkflowInput } from "@/lib/validators/workflows";

const ctx: TenantContext = {
  userId: "user-a",
  email: "a@example.com",
  orgId: "org-a",
  role: "OWNER",
  locale: "en",
};

const MEMBER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";

function input(steps: WorkflowInput["steps"]): WorkflowInput {
  return {
    name: "Notify",
    trigger: { type: "contact.created" },
    steps,
  } as WorkflowInput;
}

const notify = (id: string, userId?: string) =>
  ({ id, type: "notify.member", title: "New booking", ...(userId ? { userId } : {}) }) as const;

/** notify.member recipients are written by the run-workflow job without a further check. */
describe("upsertWorkflow: notify.member recipients must belong to the org", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantDb.mockReturnValue({
      organizationMember: { count: mocks.memberCount },
      workflow: {
        create: mocks.workflowCreate,
        update: mocks.workflowUpdate,
        findFirstOrThrow: mocks.workflowFindFirstOrThrow,
      },
    });
    mocks.workflowCreate.mockResolvedValue({ id: "wf-1" });
    mocks.workflowUpdate.mockResolvedValue({ id: "wf-1", version: 2 });
    mocks.workflowFindFirstOrThrow.mockResolvedValue({ id: "wf-1", version: 1 });
  });

  it("rejects a recipient who is not a member of this org, before creating", async () => {
    mocks.memberCount.mockResolvedValue(0);
    await expect(upsertWorkflow(ctx, input([notify("s1", FOREIGN)]))).rejects.toMatchObject({
      code: "recipient_not_member",
    });
    expect(mocks.tenantDb).toHaveBeenCalledWith("org-a");
    expect(mocks.memberCount).toHaveBeenCalledWith({ where: { userId: { in: [FOREIGN] } } });
    expect(mocks.workflowCreate).not.toHaveBeenCalled();
  });

  it("rejects a mix of a member and a foreign recipient on update, before writing", async () => {
    mocks.memberCount.mockResolvedValue(1);
    await expect(
      upsertWorkflow(ctx, input([notify("s1", MEMBER), notify("s2", FOREIGN)]), "wf-1"),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(mocks.workflowUpdate).not.toHaveBeenCalled();
  });

  it("accepts member recipients, counting a repeated recipient once", async () => {
    mocks.memberCount.mockResolvedValue(1);
    await upsertWorkflow(ctx, input([notify("s1", MEMBER), notify("s2", MEMBER)]));
    expect(mocks.memberCount).toHaveBeenCalledWith({ where: { userId: { in: [MEMBER] } } });
    expect(mocks.workflowCreate).toHaveBeenCalledTimes(1);
  });

  it("needs no lookup when every notify step uses the default recipient (the creator)", async () => {
    await upsertWorkflow(ctx, input([notify("s1")]));
    expect(mocks.memberCount).not.toHaveBeenCalled();
    expect(mocks.workflowCreate).toHaveBeenCalledTimes(1);
  });
});
