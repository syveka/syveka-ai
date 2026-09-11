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
 * message that could echo a connection string) without changing the actual
 * return value in any case.
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

  it("returns null AND logs a sanitized diagnostic when the failure is not an AuthError (e.g. a DB error), instead of discarding it identically to a real new user", async () => {
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
    mocks.findFirst.mockRejectedValue(
      Object.assign(new Error("Can't reach database server at db.example:5432"), {
        name: "PrismaClientInitializationError",
      }),
    );

    const { getTenantContextOrNull } = await import("@/server/auth/session");
    const ctx = await getTenantContextOrNull();

    expect(ctx).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedText = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(JSON.parse(loggedText)).toEqual({
      event: "get_tenant_context_or_null_unexpected_error",
      name: "PrismaClientInitializationError",
    });
    expect(loggedText).not.toContain("db.example");
  });
});
