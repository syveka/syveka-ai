import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Next.js renders a layout and its page in parallel. When the layout
 * redirects (no session, no organization, not a superadmin) or shows another
 * view (Creator Studio switched off), the page still runs; a guard error it
 * throws then reaches Sentry as an unhandled request error (staging:
 * AuthError on GET /[locale]/dashboard and /[locale]/admin/organizations,
 * FeatureDisabledError on GET /[locale]/creator-studio), although the user
 * only sees the layout's response. The page guards settle those states the
 * way the layouts do. Mocked: the session, the audit write, redirect.
 */

const m = vi.hoisted(() => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403 = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const state = { authServiceDown: false };
  return {
    AuthError,
    state,
    assertAuthServiceAvailable: vi.fn(async () => {
      if (state.authServiceDown) {
        throw Object.assign(new Error("Auth service unavailable"), {
          name: "AuthServiceUnavailableError",
        });
      }
    }),
    getTenantContextOrNull: vi.fn(),
    requireSuperadmin: vi.fn(),
    audit: vi.fn(),
    isFeatureEnabled: vi.fn(),
    listCreatorProfiles: vi.fn(),
    redirect: vi.fn((path: string) => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: path });
    }),
  };
});

vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/server/auth/session", () => ({
  AuthError: m.AuthError,
  assertAuthServiceAvailable: m.assertAuthServiceAvailable,
  getTenantContextOrNull: m.getTenantContextOrNull,
  getTenantContext: vi.fn(),
}));
vi.mock("@/server/auth/superadmin", () => ({ requireSuperadmin: m.requireSuperadmin }));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
vi.mock("@/server/services/feature-flags", () => ({ isFeatureEnabled: m.isFeatureEnabled }));
vi.mock("@/server/services/creator-profiles", () => ({
  CREATOR_STUDIO_FLAG: "creator_studio_v1",
  listCreatorProfiles: m.listCreatorProfiles,
}));
vi.mock("@/server/services/creator-credits", () => ({
  getCreatorCreditBalance: vi.fn(async () => ({ availableCredits: 0 })),
}));
vi.mock("@/server/services/creator-posts", () => ({ listCreatorPosts: vi.fn(async () => []) }));
vi.mock("next-intl/server", () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock("@/i18n/routing", () => ({ Link: () => null }));

import { requirePagePermission, requireSuperadminPage } from "@/server/auth/page-guard";
import CreatorStudioOverviewPage from "@/app/[locale]/(app)/creator-studio/page";

const ctx = (role: "OWNER" | "VIEWER") => ({
  userId: "user-1",
  email: "user@example.test",
  orgId: "org-1",
  role,
  locale: "en",
});

async function redirectedTo(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const to = (error as { redirectTo?: string }).redirectTo;
    if (to === undefined) throw error;
    return to;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  m.state.authServiceDown = false;
});

describe("an auth-service outage stays observable", () => {
  it("requirePagePermission: throws AuthServiceUnavailableError instead of redirecting", async () => {
    m.getTenantContextOrNull.mockResolvedValue(null);
    m.state.authServiceDown = true;
    await expect(requirePagePermission("crm:read")).rejects.toMatchObject({
      name: "AuthServiceUnavailableError",
    });
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("requireSuperadminPage: throws AuthServiceUnavailableError instead of redirecting", async () => {
    m.requireSuperadmin.mockRejectedValue(new m.AuthError("Not authenticated", 401));
    m.state.authServiceDown = true;
    await expect(requireSuperadminPage()).rejects.toMatchObject({
      name: "AuthServiceUnavailableError",
    });
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("the Creator Studio page: throws, never renders or redirects", async () => {
    m.getTenantContextOrNull.mockResolvedValue(null);
    m.state.authServiceDown = true;
    await expect(CreatorStudioOverviewPage()).rejects.toMatchObject({
      name: "AuthServiceUnavailableError",
    });
    expect(m.redirect).not.toHaveBeenCalled();
    expect(m.listCreatorProfiles).not.toHaveBeenCalled();
  });

  it("a signed-in user is never checked against the outage path", async () => {
    m.getTenantContextOrNull.mockResolvedValue(ctx("OWNER"));
    m.state.authServiceDown = true;
    await expect(requirePagePermission("crm:read")).resolves.toMatchObject({ orgId: "org-1" });
    expect(m.assertAuthServiceAvailable).not.toHaveBeenCalled();
  });
});

describe("requirePagePermission", () => {
  it("no session or no usable membership: redirects to /onboarding, as (app)/layout does", async () => {
    m.getTenantContextOrNull.mockResolvedValue(null);
    expect(await redirectedTo(() => requirePagePermission("crm:read"))).toBe("/onboarding");
  });

  it("returns the tenant context when the role holds the permission", async () => {
    m.getTenantContextOrNull.mockResolvedValue(ctx("VIEWER"));
    await expect(requirePagePermission("crm:read")).resolves.toMatchObject({ orgId: "org-1" });
    expect(m.redirect).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("a missing permission still throws a 403 AuthError and is audited (unchanged)", async () => {
    m.getTenantContextOrNull.mockResolvedValue(ctx("VIEWER"));
    await expect(requirePagePermission("crm:write")).rejects.toMatchObject({
      name: "AuthError",
      status: 403,
    });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      expect.objectContaining({ action: "authz.denied", resourceId: "crm:write" }),
    );
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("an unexpected failure (database) is rethrown, never turned into a redirect", async () => {
    m.getTenantContextOrNull.mockRejectedValue(new Error("database unavailable"));
    await expect(requirePagePermission("crm:read")).rejects.toThrow("database unavailable");
    expect(m.redirect).not.toHaveBeenCalled();
  });
});

describe("requireSuperadminPage", () => {
  it.each([
    ["signed out", new m.AuthError("Not authenticated", 401)],
    ["not a superadmin", new m.AuthError("Superadmin required", 403)],
  ])("%s: redirects to /dashboard, as (superadmin)/layout does", async (_, error) => {
    m.requireSuperadmin.mockRejectedValue(error);
    expect(await redirectedTo(() => requireSuperadminPage())).toBe("/dashboard");
  });

  it("returns the superadmin", async () => {
    m.requireSuperadmin.mockResolvedValue({ userId: "admin-1", email: "admin@example.test" });
    await expect(requireSuperadminPage()).resolves.toEqual({
      userId: "admin-1",
      email: "admin@example.test",
    });
  });

  it("an unexpected failure is rethrown", async () => {
    m.requireSuperadmin.mockRejectedValue(new Error("Supabase client setup failed"));
    await expect(requireSuperadminPage()).rejects.toThrow("Supabase client setup failed");
    expect(m.redirect).not.toHaveBeenCalled();
  });
});

describe("pages that rely on the page guards", () => {
  const root = path.join(__dirname, "../..");
  it.each([
    ["src/app/[locale]/(app)/dashboard/page.tsx", 'requirePagePermission("crm:read")'],
    ["src/app/[locale]/(app)/creator-studio/page.tsx", 'requirePagePermission("creator:read")'],
    ["src/app/[locale]/(superadmin)/admin/organizations/page.tsx", "requireSuperadminPage()"],
    [
      "src/app/[locale]/(superadmin)/admin/organizations/[orgId]/page.tsx",
      "requireSuperadminPage()",
    ],
  ])("%s uses %s, not the throwing guard", (file, guard) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(source).toContain(guard);
    expect(source).not.toMatch(/\brequirePermission\(|\brequireSuperadmin\(/);
  });
});

describe("Creator Studio overview page", () => {
  it("with the feature on: reads its data as before", async () => {
    m.getTenantContextOrNull.mockResolvedValue(ctx("OWNER"));
    m.isFeatureEnabled.mockResolvedValue(true);
    m.listCreatorProfiles.mockResolvedValue([]);
    await expect(CreatorStudioOverviewPage()).resolves.not.toBeNull();
    expect(m.listCreatorProfiles).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }));
  });

  it("while the feature is off: renders nothing and reads no Creator Studio data", async () => {
    m.getTenantContextOrNull.mockResolvedValue(ctx("OWNER"));
    m.isFeatureEnabled.mockResolvedValue(false);
    await expect(CreatorStudioOverviewPage()).resolves.toBeNull();
    expect(m.isFeatureEnabled).toHaveBeenCalledWith("org-1", "creator_studio_v1");
    expect(m.listCreatorProfiles).not.toHaveBeenCalled();
  });

  it("with no organization: redirects instead of throwing", async () => {
    m.getTenantContextOrNull.mockResolvedValue(null);
    expect(await redirectedTo(() => CreatorStudioOverviewPage())).toBe("/onboarding");
    expect(m.listCreatorProfiles).not.toHaveBeenCalled();
  });
});
