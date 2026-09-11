import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/server/db/prisma", () => ({
  prisma: { organizationMember: { findFirst: mocks.findFirst, count: mocks.count } },
}));

const AUTH_USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(0);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * Direct reproduction of the real staging state proven by a live, read-only
 * DB query: claimed_org_id === membership_org_id, and the organization's
 * deleted_at is NULL. This exact shape should be the textbook success case
 * for getTenantContext() -- if it is NOT, the bug is in this function's own
 * logic, not in session delivery (cookies/SSR) or the database state.
 */
describe("getTenantContext", () => {
  it("succeeds when the JWT's last_active_org claim matches an active membership", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: AUTH_USER_ID,
          email: "e2e-user@example.test",
          app_metadata: { last_active_org: ORG_ID },
        },
      },
      error: null,
    });
    mocks.findFirst.mockResolvedValue({
      organizationId: ORG_ID,
      role: "OWNER",
      organization: { defaultLocale: "FI", deletedAt: null },
    });

    const { getTenantContext } = await import("@/server/auth/session");
    const ctx = await getTenantContext();

    expect(ctx).toEqual({
      userId: AUTH_USER_ID,
      email: "e2e-user@example.test",
      orgId: ORG_ID,
      role: "OWNER",
      locale: "fi",
    });
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: AUTH_USER_ID, organizationId: ORG_ID },
      }),
    );
  });

  it("falls back to the earliest membership when no last_active_org claim is set", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: { id: AUTH_USER_ID, email: "e2e-user@example.test", app_metadata: {} },
      },
      error: null,
    });
    mocks.findFirst.mockResolvedValue({
      organizationId: ORG_ID,
      role: "OWNER",
      organization: { defaultLocale: "FI", deletedAt: null },
    });

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).resolves.toMatchObject({ orgId: ORG_ID });
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: AUTH_USER_ID } }),
    );
  });

  it("throws (no tenant context) when no user is authenticated", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow("Not authenticated");
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("throws (no tenant context) when the matched organization is soft-deleted, and logs a diagnostic distinguishing it from zero memberships", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: AUTH_USER_ID,
          email: "e2e-user@example.test",
          app_metadata: { last_active_org: ORG_ID },
        },
      },
      error: null,
    });
    mocks.findFirst.mockResolvedValue({
      organizationId: ORG_ID,
      role: "OWNER",
      organization: { defaultLocale: "FI", deletedAt: new Date("2026-01-01") },
    });
    mocks.count.mockResolvedValue(1);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow("No organization membership");

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({
      event: "tenant_context_no_usable_membership",
      userId: AUTH_USER_ID,
      hadClaimOrg: true,
      matchedMembership: true,
      matchedMembershipOrgDeleted: true,
      totalMembershipsIgnoringClaim: 1,
    });
  });

  it("throws (no tenant context) with a diagnostic showing zero memberships when the claim matches nothing at all", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: AUTH_USER_ID,
          email: "e2e-user@example.test",
          app_metadata: { last_active_org: ORG_ID },
        },
      },
      error: null,
    });
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(0);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow("No organization membership");

    const logged = JSON.parse(consoleErrorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({
      event: "tenant_context_no_usable_membership",
      userId: AUTH_USER_ID,
      hadClaimOrg: true,
      matchedMembership: false,
      matchedMembershipOrgDeleted: false,
      totalMembershipsIgnoringClaim: 0,
    });
  });

  it("never logs the email, the claim value, or any other PII on failure", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: AUTH_USER_ID,
          email: "e2e-user@example.test",
          app_metadata: { last_active_org: ORG_ID },
        },
      },
      error: null,
    });
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(0);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow();

    const loggedText = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(loggedText).not.toContain("e2e-user@example.test");
    expect(loggedText).not.toContain(ORG_ID);
  });
});
