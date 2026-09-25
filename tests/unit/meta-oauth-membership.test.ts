import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindFirst: vi.fn(),
  socialUpsert: vi.fn(),
  connectAccount: vi.fn(),
  tenantDb: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({ tenantDb: mocks.tenantDb }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/server/social", () => ({
  getSocialPublishingProvider: () => ({ connectAccount: mocks.connectAccount }),
}));
vi.mock("@/server/social/meta-provider", () => ({ metaAuthorizeUrl: vi.fn() }));
vi.mock("@/server/integrations/meta/client", () => ({ isMetaConfigured: () => true }));
vi.mock("@/server/integrations/social/crypto", () => ({
  encryptSocialToken: (v: string) => `enc:${v}`,
  decryptSocialToken: (v: string) => v,
}));

import { completeMetaOAuthCallback } from "@/server/services/creator-social-accounts";
import { buildSocialOAuthState } from "@/server/social/oauth-state";

const originalStateSecret = process.env.META_OAUTH_STATE_SECRET;

/**
 * The signed state proves the Meta flow was started by an authorized member up
 * to 10 minutes ago, not that they still are one when the callback lands.
 */
describe("completeMetaOAuthCallback membership re-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_OAUTH_STATE_SECRET = "a-test-secret-that-is-long-enough";
    mocks.tenantDb.mockReturnValue({
      organizationMember: { findFirst: mocks.memberFindFirst },
      socialAccount: { upsert: mocks.socialUpsert },
    });
    mocks.connectAccount.mockResolvedValue({
      externalAccountId: "ig-1",
      displayName: "Shop",
      accessToken: "access-token",
      refreshToken: null,
      scopes: [],
      tokenExpiresAt: null,
    });
    mocks.socialUpsert.mockResolvedValue({ id: "acct-1" });
  });

  afterEach(() => {
    process.env.META_OAUTH_STATE_SECRET = originalStateSecret;
  });

  const state = () => buildSocialOAuthState("org-a", "user-a", "INSTAGRAM");

  it("rejects a user who is no longer a member, before exchanging the code", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);
    await expect(completeMetaOAuthCallback({ code: "c", state: state() })).rejects.toMatchObject({
      code: "membership_revoked",
    });
    expect(mocks.connectAccount).not.toHaveBeenCalled();
    expect(mocks.socialUpsert).not.toHaveBeenCalled();
  });

  it("rejects a member downgraded below creator:manage-social-accounts", async () => {
    mocks.memberFindFirst.mockResolvedValue({ role: "VIEWER" });
    await expect(completeMetaOAuthCallback({ code: "c", state: state() })).rejects.toMatchObject({
      code: "membership_revoked",
    });
    expect(mocks.connectAccount).not.toHaveBeenCalled();
  });

  it("looks the member up in the signed org only, excluding soft-deleted orgs", async () => {
    mocks.memberFindFirst.mockResolvedValue({ role: "OWNER" });
    await completeMetaOAuthCallback({ code: "c", state: state() });
    expect(mocks.tenantDb).toHaveBeenCalledWith("org-a");
    expect(mocks.memberFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-a", organization: { deletedAt: null } },
      select: { role: true },
    });
  });

  it("connects the account for a current authorized member", async () => {
    mocks.memberFindFirst.mockResolvedValue({ role: "OWNER" });
    await expect(completeMetaOAuthCallback({ code: "c", state: state() })).resolves.toEqual({
      orgId: "org-a",
      accountId: "acct-1",
    });
    expect(mocks.connectAccount).toHaveBeenCalledTimes(1);
    expect(mocks.socialUpsert).toHaveBeenCalledTimes(1);
  });
});
