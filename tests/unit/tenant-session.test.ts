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

/**
 * Live staging evidence (run 34647471902, decoded straight from the failing
 * Playwright trace's session cookie): the JWT's app_metadata.last_active_org
 * claim exactly matched a real, non-deleted membership -- the textbook
 * success case above -- yet the same request still got redirected to
 * /onboarding. That rules out a claim/membership mismatch entirely and
 * leaves only two candidates: supabase.auth.getUser() returned an error that
 * getSessionUser() silently discarded (treating it identically to "no
 * session"), or getTenantContext() threw something other than AuthError that
 * getTenantContextOrNull()'s bare `catch {}` silently discarded too. Both
 * were previously indistinguishable, in the UI and in the logs, from a
 * genuinely logged-out or brand-new user. These tests lock in the fix: both
 * paths now log a sanitized diagnostic (name/status only, no PII, no error
 * message that could echo a connection string). getSessionUser() still
 * returns null on error; getTenantContextOrNull() now rethrows a non-AuthError
 * rather than reporting it as a missing membership.
 */
describe("getSessionUser", () => {
  it("returns the user and logs nothing when getUser() succeeds cleanly", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: "e2e-user@example.test", app_metadata: {} } },
      error: null,
    });

    const { getSessionUser } = await import("@/server/auth/session");
    const user = await getSessionUser();

    expect(user?.id).toBe(AUTH_USER_ID);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs a sanitized diagnostic (name/status only) instead of silently discarding a getUser() error", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthApiError",
        status: 429,
        message: "rate limited: sk_live_should_never_log",
      },
    });

    const { getSessionUser } = await import("@/server/auth/session");
    const user = await getSessionUser();

    expect(user).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedText = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(JSON.parse(loggedText)).toEqual({
      event: "get_session_user_error",
      name: "AuthApiError",
      status: 429,
    });
    expect(loggedText).not.toContain("sk_live_should_never_log");
  });
});

describe("getTenantContextOrNull", () => {
  it("returns null silently (no extra log) for the expected AuthError cases", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const { getTenantContextOrNull } = await import("@/server/auth/session");
    const ctx = await getTenantContextOrNull();

    expect(ctx).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("returns the tenant context for an existing member", async () => {
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

    const { getTenantContextOrNull } = await import("@/server/auth/session");
    await expect(getTenantContextOrNull()).resolves.toMatchObject({ orgId: ORG_ID });
  });

  it("returns null for an authenticated user with no usable membership", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: "e2e-user@example.test", app_metadata: {} } },
      error: null,
    });
    mocks.findFirst.mockResolvedValue(null);

    const { getTenantContextOrNull } = await import("@/server/auth/session");
    await expect(getTenantContextOrNull()).resolves.toBeNull();
  });

  it("rethrows AND logs a sanitized diagnostic when the failure is not an AuthError (e.g. a DB error), instead of reporting it as a missing membership", async () => {
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
    const dbError = Object.assign(new Error("Can't reach database server at db.example:5432"), {
      name: "PrismaClientInitializationError",
    });
    mocks.findFirst.mockRejectedValue(dbError);

    const { getTenantContextOrNull } = await import("@/server/auth/session");
    await expect(getTenantContextOrNull()).rejects.toBe(dbError);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedText = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(JSON.parse(loggedText)).toEqual({
      event: "get_tenant_context_or_null_unexpected_error",
      name: "PrismaClientInitializationError",
    });
    expect(loggedText).not.toContain("db.example");
  });
});

/**
 * removeMember() deletes the membership but not the removed user's
 * app_metadata.last_active_org. The access-token hook already falls back to
 * the user's earliest remaining membership for the JWT; getTenantContext()
 * must do the same instead of sending a still-a-member user to /onboarding.
 */
describe("getTenantContext stale last_active_org claim", () => {
  const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
  const sessionWithClaim = () =>
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: AUTH_USER_ID,
          email: "multi-org@example.test",
          app_metadata: { last_active_org: ORG_ID },
        },
      },
      error: null,
    });
  const otherActiveMembership = {
    organizationId: OTHER_ORG_ID,
    role: "MEMBER",
    organization: { defaultLocale: "EN", deletedAt: null },
  };

  it("falls back to the user's earliest remaining active membership when the claimed org's membership is gone", async () => {
    sessionWithClaim();
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(otherActiveMembership);

    const { getTenantContext } = await import("@/server/auth/session");
    const ctx = await getTenantContext();

    expect(ctx).toMatchObject({ orgId: OTHER_ORG_ID, role: "MEMBER", locale: "en" });
    expect(mocks.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { userId: AUTH_USER_ID, organization: { deletedAt: null } },
        orderBy: { joinedAt: "asc" },
      }),
    );
    const logged = consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toContain('"event":"tenant_context_stale_claim_fallback"');
    expect(logged).not.toContain("tenant_context_no_usable_membership");
    expect(logged).not.toContain("multi-org@example.test");
    expect(logged).not.toContain(ORG_ID);
    expect(logged).not.toContain(OTHER_ORG_ID);
  });

  it("falls back when the claimed org is soft-deleted", async () => {
    sessionWithClaim();
    mocks.findFirst
      .mockResolvedValueOnce({
        organizationId: ORG_ID,
        role: "OWNER",
        organization: { defaultLocale: "FI", deletedAt: new Date("2026-09-01T00:00:00Z") },
      })
      .mockResolvedValueOnce(otherActiveMembership);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).resolves.toMatchObject({
      orgId: OTHER_ORG_ID,
      role: "MEMBER",
    });
  });

  it("still fails closed when the claim is stale and the user has no other active membership", async () => {
    sessionWithClaim();
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mocks.count.mockResolvedValue(0);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow("No organization membership");
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("never uses a fallback membership whose organization is soft-deleted", async () => {
    sessionWithClaim();
    const deleted = { deletedAt: new Date("2026-09-01T00:00:00Z"), defaultLocale: "EN" };
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      organizationId: OTHER_ORG_ID,
      role: "MEMBER",
      organization: deleted,
    });

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow("No organization membership");
  });

  it("with no claim, skips a soft-deleted earliest org and uses the next active membership", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: "no-claim@example.test", app_metadata: {} } },
      error: null,
    });
    mocks.findFirst
      .mockResolvedValueOnce({
        organizationId: ORG_ID,
        role: "OWNER",
        organization: { defaultLocale: "FI", deletedAt: new Date("2026-09-01T00:00:00Z") },
      })
      .mockResolvedValueOnce(otherActiveMembership);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).resolves.toMatchObject({
      orgId: OTHER_ORG_ID,
      role: "MEMBER",
    });
    expect(mocks.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { userId: AUTH_USER_ID, organization: { deletedAt: null } },
      }),
    );
  });

  it("does not run a fallback lookup when there is no claim at all", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: AUTH_USER_ID, email: "new@example.test", app_metadata: {} } },
      error: null,
    });
    mocks.findFirst.mockResolvedValue(null);

    const { getTenantContext } = await import("@/server/auth/session");
    await expect(getTenantContext()).rejects.toThrow("No organization membership");
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });
});
