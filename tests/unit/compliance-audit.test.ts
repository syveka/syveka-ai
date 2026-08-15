import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(async (_args: unknown) => ({ id: "audit-1" })),
  headers: vi.fn(
    async () =>
      new Map([
        ["x-forwarded-for", "203.0.113.9"],
        ["user-agent", "test-agent"],
      ]),
  ),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { complianceAuditLog: { create: mocks.auditCreate } },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  mocks.headers.mockResolvedValue(
    new Map([
      ["x-forwarded-for", "203.0.113.9"],
      ["user-agent", "test-agent"],
    ]),
  );
});

describe("complianceAudit", () => {
  it("writes actorUserId, action, resourceType/Id, and never an organizationId field", async () => {
    const { complianceAudit } = await import("@/server/services/compliance/audit");
    await complianceAudit("user-1", {
      action: "compliance_control.create",
      resourceType: "ComplianceControl",
      resourceId: "ctrl-1",
      after: { title: "x" },
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const data = (mocks.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.actorUserId).toBe("user-1");
    expect(data.actorType).toBe("user");
    expect(data.action).toBe("compliance_control.create");
    expect(data.resourceType).toBe("ComplianceControl");
    expect(data).not.toHaveProperty("organizationId");
  });

  it("actorType 'system' forces actorUserId to null, matching the tenant audit() convention", async () => {
    const { complianceAudit } = await import("@/server/services/compliance/audit");
    await complianceAudit("user-1", {
      action: "retention_execution.create",
      resourceType: "RetentionExecution",
      actorType: "system",
    });
    const data = (mocks.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.actorUserId).toBeNull();
    expect(data.actorType).toBe("system");
  });

  it("never throws into the caller's flow when headers() is unavailable (jobs/webhooks)", async () => {
    mocks.headers.mockRejectedValueOnce(new Error("no request context"));
    const { complianceAudit } = await import("@/server/services/compliance/audit");
    await expect(
      complianceAudit("user-1", { action: "x", resourceType: "Y" }),
    ).resolves.toBeUndefined();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });
});
