import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the silent authz-denial audit gap (PR #360 probe).
// Before the fix, requirePermission wrote an authz.denied audit entry only
// for a fixed "sensitive" prefix set; denials of kb:write, creator:publish,
// workflows:manage, voice:configure, … threw 403 with no trail (§12.3).
const h = vi.hoisted(() => ({
  auditMock: vi.fn(async (..._args: unknown[]) => undefined),
  getTenantContextMock: vi.fn(),
}));

vi.mock("@/server/services/audit", () => ({ audit: h.auditMock }));
vi.mock("@/server/auth/session", () => ({
  AuthError: class AuthError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
  getTenantContext: h.getTenantContextMock,
}));

import { assertPermission, auditDenial, requirePermission } from "@/server/auth/guard";
import { PERMISSIONS, can } from "@/server/auth/permissions";

const VIEWER = { userId: "u1", email: "v@test", orgId: "o1", role: "VIEWER", locale: "en" };
const MEMBER = { ...VIEWER, email: "m@test", role: "MEMBER" };

function expectDenialAudited(permission: string) {
  expect(h.auditMock).toHaveBeenCalledTimes(1);
  // Only the permission name is recorded: no request input, payload or secret.
  expect(h.auditMock).toHaveBeenCalledWith(
    {
      userId: VIEWER.userId,
      email: expect.any(String),
      orgId: "o1",
      role: expect.any(String),
      locale: "en",
    },
    { action: "authz.denied", resourceType: "permission", resourceId: permission },
  );
  const entry = h.auditMock.mock.calls[0]![1] as Record<string, unknown>;
  expect(Object.keys(entry).sort()).toEqual(["action", "resourceId", "resourceType"]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTenantContextMock.mockResolvedValue(MEMBER);
});

describe("authz-denial auditing", () => {
  it("audits a denial on a previously 'sensitive'-prefixed permission (control)", async () => {
    await expect(requirePermission("members:invite")).rejects.toMatchObject({ status: 403 });
    expectDenialAudited("members:invite");
  });

  it("audits a kb:write denial", async () => {
    await expect(requirePermission("kb:write")).rejects.toMatchObject({ status: 403 });
    expectDenialAudited("kb:write");
  });

  it("audits a creator:publish denial", async () => {
    await expect(requirePermission("creator:publish")).rejects.toMatchObject({ status: 403 });
    expectDenialAudited("creator:publish");
  });

  it("audits the denial of every permission a viewer lacks", async () => {
    h.getTenantContextMock.mockResolvedValue(VIEWER);
    const denied = PERMISSIONS.filter((p) => !can("VIEWER", p));
    expect(denied.length).toBeGreaterThan(10);
    for (const permission of denied) {
      h.auditMock.mockClear();
      await expect(requirePermission(permission)).rejects.toMatchObject({ status: 403 });
      expect(h.auditMock, permission).toHaveBeenCalledTimes(1);
      expect(h.auditMock.mock.calls[0]![1]).toEqual({
        action: "authz.denied",
        resourceType: "permission",
        resourceId: permission,
      });
    }
  });

  it("writes no audit entry when the permission is granted", async () => {
    await expect(requirePermission("crm:write")).resolves.toEqual(MEMBER);
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it("still returns 403 when the audit write fails", async () => {
    h.auditMock.mockRejectedValueOnce(new Error("db down"));
    await expect(requirePermission("kb:write")).rejects.toMatchObject({ status: 403 });
  });

  it("still returns 403 when the audit call throws synchronously or returns no promise", async () => {
    h.auditMock.mockImplementationOnce(() => {
      throw new Error("sync failure");
    });
    await expect(requirePermission("kb:write")).rejects.toMatchObject({ status: 403 });
    h.auditMock.mockImplementationOnce((() => undefined) as never);
    await expect(requirePermission("kb:write")).rejects.toMatchObject({ status: 403 });
  });

  it("assertPermission audits a denied second permission", async () => {
    await expect(assertPermission(MEMBER as never, "crm:delete")).rejects.toMatchObject({
      status: 403,
    });
    expectDenialAudited("crm:delete");
  });

  it("auditDenial never throws", async () => {
    h.auditMock.mockRejectedValueOnce(new Error("db down"));
    await expect(auditDenial(MEMBER, "chat:use")).resolves.toBeUndefined();
  });
});
