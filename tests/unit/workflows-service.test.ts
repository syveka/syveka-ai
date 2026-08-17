import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { WorkflowInput } from "@/lib/validators/workflows";

const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({ tenantDb: mocks.tenantDb }));
vi.mock("@/server/services/audit", () => ({ audit: mocks.audit }));

import { upsertWorkflow } from "@/server/services/workflows";

const ctx: TenantContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "ADMIN",
  locale: "en",
};

function input(userId?: string): WorkflowInput {
  return {
    name: "Notify owner",
    trigger: { type: "manual" },
    steps: [{ id: "notify", type: "notify.member", userId, title: "Done" }],
  };
}

function makeDb() {
  return {
    organizationMember: { count: vi.fn(async () => 1) },
    workflow: {
      create: vi.fn(async () => ({ id: "workflow-1" })),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe("workflow notification recipient isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an explicit recipient outside the current organization before writing", async () => {
    const db = makeDb();
    db.organizationMember.count.mockResolvedValue(0);
    mocks.tenantDb.mockReturnValue(db);
    const foreignUserId = "22222222-2222-4222-8222-222222222222";

    await expect(upsertWorkflow(ctx, input(foreignUserId))).rejects.toThrow(
      "Notification recipient is not a current organization member",
    );
    expect(db.organizationMember.count).toHaveBeenCalledWith({
      where: { userId: { in: [foreignUserId] } },
    });
    expect(db.workflow.create).not.toHaveBeenCalled();
  });

  it("allows an explicit recipient who is a current organization member", async () => {
    const db = makeDb();
    mocks.tenantDb.mockReturnValue(db);
    const memberUserId = "33333333-3333-4333-8333-333333333333";

    await expect(upsertWorkflow(ctx, input(memberUserId))).resolves.toMatchObject({
      id: "workflow-1",
    });
    expect(db.workflow.create).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing creator-default behavior without a redundant lookup", async () => {
    const db = makeDb();
    mocks.tenantDb.mockReturnValue(db);

    await upsertWorkflow(ctx, input());
    expect(db.organizationMember.count).not.toHaveBeenCalled();
    expect(db.workflow.create).toHaveBeenCalledTimes(1);
  });
});
