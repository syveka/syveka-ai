import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * inviteMemberAction must return stable, translatable codes and never raw
 * exception text. Mocked: the permission guard, the member service's
 * inviteMember (to throw each failure kind), cache revalidation and the
 * Supabase server client (unused by this action).
 */
const inviteMember = vi.hoisted(() => vi.fn());

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
      public readonly code: "already_member",
    ) {
      super(message);
      this.name = "MemberError";
    }
  }
  return {
    MemberError,
    inviteMember,
    acceptInvitation: vi.fn(),
    changeMemberRole: vi.fn(),
    removeMember: vi.fn(),
  };
});
vi.mock("@/server/services/billing/entitlements", () => {
  class EntitlementError extends Error {
    readonly code = "entitlement_exceeded";
    constructor(
      public readonly limit: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { EntitlementError };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServer: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSessionUser: vi.fn(), AuthError: Error }));

import { inviteMemberAction } from "@/actions/members";
import { MemberError } from "@/server/services/members";
import { EntitlementError } from "@/server/services/billing/entitlements";

const form = (email: string, role: string) => {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("role", role);
  return fd;
};

describe("inviteMemberAction error codes", () => {
  beforeEach(() => {
    inviteMember.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("invalid email or role → invalid_input, service not called", async () => {
    expect(await inviteMemberAction({}, form("not-an-email", "MEMBER"))).toEqual({
      error: "invalid_input",
    });
    expect(await inviteMemberAction({}, form("a@example.test", "OWNER"))).toEqual({
      error: "invalid_input",
    });
    expect(inviteMember).not.toHaveBeenCalled();
  });

  it("existing member → already_member", async () => {
    inviteMember.mockRejectedValue(new MemberError("Already a member", "already_member"));
    expect(await inviteMemberAction({}, form("a@example.test", "MEMBER"))).toEqual({
      error: "already_member",
    });
  });

  it("any entitlement failure (seats or past-due read-only) → plan_limit", async () => {
    inviteMember.mockRejectedValue(new EntitlementError("maxSeats", "Seat limit reached (3)"));
    expect(await inviteMemberAction({}, form("a@example.test", "MEMBER"))).toEqual({
      error: "plan_limit",
    });
  });

  it("unexpected failure → invite_failed, without leaking the message", async () => {
    inviteMember.mockRejectedValue(new Error("SMTP password rejected for smtp.internal"));
    const result = await inviteMemberAction({}, form("a@example.test", "MEMBER"));
    expect(result).toEqual({ error: "invite_failed" });
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls,
    );
    expect(logged).not.toContain("SMTP password");
  });

  it("success → invited, with the canonical role value", async () => {
    inviteMember.mockResolvedValue(undefined);
    expect(await inviteMemberAction({}, form("a@example.test", "VIEWER"))).toEqual({
      message: "invited",
    });
    expect(inviteMember.mock.calls[0]![1]).toEqual({ email: "a@example.test", role: "VIEWER" });
  });
});
