import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * changeRoleAction must return stable, translatable codes and never raw
 * exception text (CLAUDE.md §4: internal errors never reach a response).
 * Mocked: the permission guard, the member service's changeMemberRole (to
 * throw each failure kind), cache revalidation and the Supabase client.
 */
const changeMemberRole = vi.hoisted(() => vi.fn());

vi.mock("@/server/security/rate-limit", () => ({
  actionRateLimitError: vi.fn(async () => null),
  actionWriteLimitError: vi.fn(async () => null),
  emailKey: (email: string) => email,
}));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
  })),
}));
vi.mock("@/server/services/members", async () => {
  class MemberError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
      this.name = "MemberError";
    }
  }
  return {
    MemberError,
    inviteMember: vi.fn(),
    acceptInvitation: vi.fn(),
    changeMemberRole,
    removeMember: vi.fn(),
    revokeInvitation: vi.fn(),
  };
});
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServer: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSessionUser: vi.fn(), AuthError: Error }));

import { changeRoleAction, removeMemberAction } from "@/actions/members";
import { MemberError } from "@/server/services/members";

const MEMBER_ID = "33333333-3333-4333-8333-333333333333";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("changeRoleAction error codes", () => {
  beforeEach(() => {
    changeMemberRole.mockReset();
  });

  it("invalid input → invalid_input, service not called", async () => {
    const result = await changeRoleAction({}, form({ memberId: "not-a-uuid", role: "OWNER" }));

    expect(result).toEqual({ error: "invalid_input" });
    expect(changeMemberRole).not.toHaveBeenCalled();
  });

  it.each(["not_found", "owner_role", "own_role"])(
    "a member-management rule (%s) is returned as its code",
    async (code) => {
      changeMemberRole.mockRejectedValueOnce(new MemberError("rule text", code as never));

      const result = await changeRoleAction({}, form({ memberId: MEMBER_ID, role: "MEMBER" }));

      expect(result).toEqual({ error: code });
    },
  );

  it("an unexpected failure → failed, without leaking its message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    changeMemberRole.mockRejectedValueOnce(
      Object.assign(new Error("Invalid `prisma.organizationMember.update()` invocation"), {
        name: "PrismaClientKnownRequestError",
      }),
    );

    const result = await changeRoleAction({}, form({ memberId: MEMBER_ID, role: "MEMBER" }));

    expect(result).toEqual({ error: "failed" });
    expect(JSON.stringify(result)).not.toContain("prisma");
    expect(error.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
      { event: "change_member_role_failed", name: "PrismaClientKnownRequestError" },
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toContain("invocation");
    error.mockRestore();
  });

  it("success → updated", async () => {
    changeMemberRole.mockResolvedValueOnce(undefined);

    const result = await changeRoleAction({}, form({ memberId: MEMBER_ID, role: "ADMIN" }));

    expect(result).toEqual({ message: "updated" });
    expect(changeMemberRole).toHaveBeenCalledWith(expect.anything(), MEMBER_ID, "ADMIN");
  });
});

/**
 * Changing a role and removing a member are state-changing writes: they take
 * the shared members write limit like revoking an invitation does, and are
 * refused (no write) when it is exceeded or can't be verified.
 */
describe("member management write limit", () => {
  it.each(["rate_limited", "service_unavailable"] as const)(
    "changeRoleAction: %s → returned as the error, no role change",
    async (refusal) => {
      const { actionWriteLimitError } = await import("@/server/security/rate-limit");
      vi.mocked(actionWriteLimitError).mockResolvedValueOnce(refusal);
      changeMemberRole.mockReset();

      const result = await changeRoleAction({}, form({ memberId: MEMBER_ID, role: "ADMIN" }));

      expect(result).toEqual({ error: refusal });
      expect(changeMemberRole).not.toHaveBeenCalled();
      expect(actionWriteLimitError).toHaveBeenCalledWith(
        "members",
        expect.objectContaining({ orgId: "11111111-1111-4111-8111-111111111111" }),
      );
    },
  );

  it("removeMemberAction: a refusal throws and removes no one", async () => {
    const { actionWriteLimitError } = await import("@/server/security/rate-limit");
    const { removeMember } = await import("@/server/services/members");
    vi.mocked(actionWriteLimitError).mockResolvedValueOnce("rate_limited");

    await expect(removeMemberAction(MEMBER_ID)).rejects.toThrow("rate_limited");
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("removeMemberAction: within the limit the member is removed", async () => {
    const { removeMember } = await import("@/server/services/members");
    await removeMemberAction(MEMBER_ID);
    expect(removeMember).toHaveBeenCalledWith(expect.anything(), MEMBER_ID);
  });
});
