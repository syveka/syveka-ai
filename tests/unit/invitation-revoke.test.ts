import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Withdrawing a pending invitation (revokeInvitation / revokeInvitationAction):
 * the seat is freed, the link dies, the token is replaced so a later re-invite
 * can't revive it, and only the organization's own invitations are reachable.
 * The real service and action run over a fake tenant-scoped database.
 */

type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  token: string;
};

const s = vi.hoisted(() => ({
  invitations: [] as Invitation[],
  updateManyFailure: null as Error | null,
  ctx: {
    orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
  } as Record<string, string> | null,
}));

const fx = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  revalidatePath: vi.fn(),
  consoleError: vi.fn(),
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: fx.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSessionUser: vi.fn(), AuthError: Error }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => {
    if (!s.ctx) throw new Error("Missing permission");
    return s.ctx;
  }),
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: vi.fn(),
  createSupabaseServer: vi.fn(),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  getEntitlements: vi.fn(),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/billing/seats", () => ({
  countActiveSeats: vi.fn(),
  lockOrgSeats: vi.fn(),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: vi.fn() }));
vi.mock("@/env", () => ({ getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.test" }) }));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/lib/auth-redirect", () => ({
  inviteContinuation: vi.fn(),
  localizedPath: vi.fn(),
  normalizeLocale: vi.fn(),
}));
vi.mock("@/server/security/rate-limit", () => ({
  actionRateLimitError: vi.fn(async () => null),
  emailKey: (e: string) => e,
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {},
  // The real tenantDb injects organizationId into every where/data; this fake
  // scopes reads and writes to the organization the same way.
  tenantDb: (orgId: string) => ({
    invitation: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = s.invitations.find((i) => i.id === where.id && i.organizationId === orgId);
        return row ? { id: row.id, email: row.email, role: row.role, status: row.status } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: { status: string; token: string };
        }) => {
          if (s.updateManyFailure) throw s.updateManyFailure;
          // Like Prisma: a filter that isn't given matches every row.
          const rows = s.invitations.filter(
            (i) =>
              i.id === where.id &&
              (where.status === undefined || i.status === where.status) &&
              i.organizationId === orgId,
          );
          for (const row of rows) Object.assign(row, { status: data.status, token: data.token });
          return { count: rows.length };
        },
      ),
    },
  }),
}));

import { MemberError, revokeInvitation } from "@/server/services/members";
import { revokeInvitationAction } from "@/actions/members";
import type { TenantContext } from "@/server/auth/session";

const ctx = {
  orgId: ORG_A,
  userId: "22222222-2222-4222-8222-222222222222",
  role: "OWNER",
} as unknown as TenantContext;
const OLD_TOKEN = "3f2b8c1e-9a4d-4c7b-8e2f-000000000001";

beforeEach(() => {
  s.updateManyFailure = null;
  s.ctx = { ...ctx };
  s.invitations = [
    {
      id: "inv-a",
      organizationId: ORG_A,
      email: "typo@example.test",
      role: "MEMBER",
      status: "PENDING",
      token: OLD_TOKEN,
    },
    {
      id: "inv-accepted",
      organizationId: ORG_A,
      email: "joined@example.test",
      role: "ADMIN",
      status: "ACCEPTED",
      token: "3f2b8c1e-9a4d-4c7b-8e2f-000000000002",
    },
    {
      id: "inv-b",
      organizationId: ORG_B,
      email: "other-org@example.test",
      role: "MEMBER",
      status: "PENDING",
      token: "3f2b8c1e-9a4d-4c7b-8e2f-000000000003",
    },
  ];
  fx.audit.mockClear();
  fx.revalidatePath.mockClear();
  fx.consoleError.mockClear();
  vi.spyOn(console, "error").mockImplementation(fx.consoleError);
});

describe("revokeInvitation", () => {
  it("marks a pending invitation REVOKED and replaces its token", async () => {
    await revokeInvitation(ctx, "inv-a");
    const row = s.invitations.find((i) => i.id === "inv-a")!;
    expect(row.status).toBe("REVOKED");
    expect(row.token).not.toBe(OLD_TOKEN);
    expect(row.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("writes one audit row naming the invitation, never a token", async () => {
    await revokeInvitation(ctx, "inv-a");
    expect(fx.audit).toHaveBeenCalledTimes(1);
    const [auditCtx, entry] = fx.audit.mock.calls[0] as unknown as [
      typeof ctx,
      Record<string, unknown>,
    ];
    expect(auditCtx).toEqual(ctx);
    expect(entry).toMatchObject({
      action: "member.invite_revoke",
      resourceType: "invitation",
      resourceId: "inv-a",
      before: { email: "typo@example.test", role: "MEMBER", status: "PENDING" },
      after: { status: "REVOKED" },
    });
    expect(JSON.stringify(entry)).not.toContain(OLD_TOKEN);
  });

  it("cannot reach another organization's invitation", async () => {
    await expect(revokeInvitation(ctx, "inv-b")).rejects.toMatchObject({ code: "not_pending" });
    expect(s.invitations.find((i) => i.id === "inv-b")!.status).toBe("PENDING");
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("refuses an invitation that is no longer pending, and an unknown id", async () => {
    await expect(revokeInvitation(ctx, "inv-accepted")).rejects.toBeInstanceOf(MemberError);
    await expect(revokeInvitation(ctx, "missing")).rejects.toMatchObject({ code: "not_pending" });
    expect(s.invitations.find((i) => i.id === "inv-accepted")!.status).toBe("ACCEPTED");
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("an invitation accepted between the read and the write is refused, not re-written", async () => {
    // The acceptance commits right after findFirst saw PENDING.
    const row = s.invitations.find((i) => i.id === "inv-a")!;
    const original = s.invitations;
    s.invitations = new Proxy(original, {
      get(target, prop, receiver) {
        if (prop === "filter") row.status = "ACCEPTED";
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(revokeInvitation(ctx, "inv-a")).rejects.toMatchObject({ code: "not_pending" });
    expect(row.status).toBe("ACCEPTED");
    expect(row.token).toBe(OLD_TOKEN);
    expect(fx.audit).not.toHaveBeenCalled();
  });
});

describe("revokeInvitationAction", () => {
  it("success: revoked, and the members page is revalidated", async () => {
    expect(await revokeInvitationAction("inv-a")).toEqual({ message: "revoked" });
    expect(fx.revalidatePath).toHaveBeenCalledWith("/settings/members");
  });

  it("a stable code for an invitation that isn't pending", async () => {
    expect(await revokeInvitationAction("inv-accepted")).toEqual({ error: "not_pending" });
    expect(fx.revalidatePath).not.toHaveBeenCalled();
  });

  it("an unexpected failure becomes revoke_failed and logs only the error's name", async () => {
    s.updateManyFailure = new Error("connection refused: db-host-with-secret");
    expect(await revokeInvitationAction("inv-a")).toEqual({ error: "revoke_failed" });
    const logged = fx.consoleError.mock.calls.flat().join(" ");
    expect(logged).toContain('"event":"revoke_invitation_failed"');
    expect(logged).not.toContain("db-host-with-secret");
  });

  it("requires the members:invite permission before touching anything", async () => {
    s.ctx = null;
    await expect(revokeInvitationAction("inv-a")).rejects.toThrow("Missing permission");
    expect(s.invitations.find((i) => i.id === "inv-a")!.status).toBe("PENDING");
  });
});
