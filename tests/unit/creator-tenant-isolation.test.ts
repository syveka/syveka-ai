import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Tenant isolation (Phase 17): every Creator Studio service must resolve
 * its Prisma client via tenantDb(ctx.orgId) — the caller's own org, never a
 * client-suppliable value — for creator profiles, media, campaigns, posts,
 * social accounts, and analytics. tenantDb() itself (src/server/db/tenant.ts)
 * is what makes org A structurally unable to read/write org B's rows; these
 * tests prove every entry point actually goes through it with the right id.
 */

const { tenantDbMock, unscopedPrismaMock, auditMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  unscopedPrismaMock: {
    organization: { findUnique: vi.fn(async () => ({ settings: { creator_studio_v1: true } })) },
  },
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: unscopedPrismaMock,
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));

import { listCreatorProfiles } from "@/server/services/creator-profiles";
import { listGenerations } from "@/server/services/creator-generations";
import { listCreatorCampaigns } from "@/server/services/creator-campaigns";
import { listCreatorPosts } from "@/server/services/creator-posts";
import { listSocialAccounts } from "@/server/services/creator-social-accounts";
import {
  getCreatorGenerationAnalytics,
  getCreatorPublishingAnalytics,
} from "@/server/services/creator-analytics";

function ctx(orgId: string): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function emptyDb() {
  return {
    creatorProfile: { findMany: vi.fn(async () => []) },
    creatorGeneration: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({
        _sum: { creditsConsumed: null },
        _avg: { latencyMs: null },
      })),
    },
    creatorCampaign: { findMany: vi.fn(async () => []) },
    creatorPost: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    socialAccount: {
      findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    },
  };
}

describe("Creator Studio tenant isolation", () => {
  let dbA: ReturnType<typeof emptyDb>;
  let dbB: ReturnType<typeof emptyDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    unscopedPrismaMock.organization.findUnique.mockResolvedValue({
      settings: { creator_studio_v1: true },
    });
    dbA = emptyDb();
    dbB = emptyDb();
    tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : dbA));
  });

  it("listCreatorProfiles resolves the caller's own org, never a cross-tenant one", async () => {
    await listCreatorProfiles(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(dbA.creatorProfile.findMany).not.toHaveBeenCalled();
    expect(dbB.creatorProfile.findMany).toHaveBeenCalled();
  });

  it("listGenerations resolves the caller's own org", async () => {
    await listGenerations(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(dbA.creatorGeneration.findMany).not.toHaveBeenCalled();
  });

  it("listCreatorCampaigns resolves the caller's own org", async () => {
    await listCreatorCampaigns(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(dbA.creatorCampaign.findMany).not.toHaveBeenCalled();
  });

  it("listCreatorPosts resolves the caller's own org", async () => {
    await listCreatorPosts(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(dbA.creatorPost.findMany).not.toHaveBeenCalled();
  });

  it("listSocialAccounts resolves the caller's own org and never leaks tokens", async () => {
    dbB.socialAccount.findMany.mockResolvedValueOnce([
      { id: "acc-1", accessTokenEnc: "secret", refreshTokenEnc: "secret2", displayName: "x" },
    ]);
    const result = await listSocialAccounts(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(result[0]).not.toHaveProperty("accessTokenEnc");
    expect(result[0]).not.toHaveProperty("refreshTokenEnc");
  });

  it("analytics aggregations resolve the caller's own org", async () => {
    await getCreatorGenerationAnalytics(ctx("org-b"));
    await getCreatorPublishingAnalytics(ctx("org-b"));
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
    expect(dbA.creatorGeneration.groupBy).not.toHaveBeenCalled();
    expect(dbA.creatorPost.groupBy).not.toHaveBeenCalled();
  });

  it("switching the caller's org switches which tenant client every service uses", async () => {
    await listCreatorProfiles(ctx("org-a"));
    expect(dbA.creatorProfile.findMany).toHaveBeenCalledTimes(1);
    expect(dbB.creatorProfile.findMany).not.toHaveBeenCalled();

    await listCreatorProfiles(ctx("org-b"));
    expect(dbB.creatorProfile.findMany).toHaveBeenCalledTimes(1);
    expect(dbA.creatorProfile.findMany).toHaveBeenCalledTimes(1); // unchanged
  });
});
