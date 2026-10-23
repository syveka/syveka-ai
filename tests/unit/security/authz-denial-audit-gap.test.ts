import { beforeEach, describe, expect, it, vi } from "vitest";

// DEFENSIVE probe for the silent authz-denial audit gap in
// src/server/auth/guard.ts: requirePermission writes an authz.denied audit
// entry only when the denied permission starts with one of a fixed "sensitive"
// prefix set. Denials of other state-changing permissions (kb:write,
// creator:publish, workflows:manage, voice:configure, …) throw 403 but are
// NEVER audited, so repeated probing of those endpoints by a low-privilege
// member leaves no trail (defeats CLAUDE.md §12.3 denial-auditing).
const h = vi.hoisted(() => ({
  auditMock: vi.fn(async () => undefined),
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

import { requirePermission } from "@/server/auth/guard";

beforeEach(() => {
  vi.clearAllMocks();
  h.getTenantContextMock.mockResolvedValue({
    userId: "u1",
    email: "m@test",
    orgId: "o1",
    role: "MEMBER",
    locale: "en",
  });
});

describe("authz-denial auditing", () => {
  it("audits a denial on a 'sensitive'-prefixed permission (control)", async () => {
    await expect(requirePermission("members:invite" as never)).rejects.toThrow();
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });

  it("FINDING: a kb:write denial is thrown but NOT audited", async () => {
    await expect(requirePermission("kb:write" as never)).rejects.toThrow();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it("FINDING: a creator:publish denial is thrown but NOT audited", async () => {
    await expect(requirePermission("creator:publish" as never)).rejects.toThrow();
    expect(h.auditMock).not.toHaveBeenCalled();
  });
});
