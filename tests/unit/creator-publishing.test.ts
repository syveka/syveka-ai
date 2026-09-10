import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  unscopedPrismaMock,
  getSocialPublishingProviderMock,
  decryptSocialTokenMock,
  auditMock,
  notifyUserMock,
  createSignedUrlMock,
} = vi.hoisted(() => ({
  unscopedPrismaMock: {
    creatorPost: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => ({})),
      count: vi.fn(async (_args: unknown) => 0),
    },
    creatorReferenceAsset: { findMany: vi.fn() },
  },
  getSocialPublishingProviderMock: vi.fn(),
  decryptSocialTokenMock: vi.fn(() => "plain-token"),
  auditMock: vi.fn(async () => undefined),
  notifyUserMock: vi.fn(async () => undefined),
  createSignedUrlMock: vi.fn(async () => ({
    data: { signedUrl: "https://storage.example/signed/asset.png" },
    error: null,
  })),
}));

vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: unscopedPrismaMock, tenantDb: vi.fn() }));
vi.mock("@/server/social", () => ({
  getSocialPublishingProvider: getSocialPublishingProviderMock,
}));
vi.mock("@/server/integrations/social/crypto", () => ({
  decryptSocialToken: decryptSocialTokenMock,
  encryptSocialToken: vi.fn((v: string) => `enc:${v}`),
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({
    storage: { from: () => ({ createSignedUrl: createSignedUrlMock }) },
  }),
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/creator-notifications", () => ({ notifyUser: notifyUserMock }));

import { publishCreatorPost, PublishGuardError } from "@/server/services/creator-publishing";

function approvedPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    organizationId: "org-a",
    createdById: "user-1",
    platform: "INSTAGRAM",
    caption: "hello",
    hashtags: ["#a"],
    assetIds: ["asset-1"],
    approvalStatus: "APPROVED",
    contentVersion: 1,
    approvedContentVersion: 1,
    publishStatus: "SCHEDULED",
    campaignId: null,
    campaign: null,
    scheduledFor: new Date(),
    socialAccount: {
      id: "acct-1",
      status: "CONNECTED",
      accessTokenEnc: "enc:token",
      externalAccountId: "ext-1",
    },
    ...overrides,
  };
}

describe("publishCreatorPost", () => {
  let provider: {
    publishPost: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      publishPost: vi.fn(async () => ({
        externalPostId: "ext-post-1",
        providerRequestId: "req-1",
      })),
    };
    getSocialPublishingProviderMock.mockReturnValue(provider);
    unscopedPrismaMock.creatorPost.updateMany.mockResolvedValue({ count: 1 });
    unscopedPrismaMock.creatorReferenceAsset.findMany.mockResolvedValue([
      { id: "asset-1", storagePath: "org-a/x.png", assetType: "generated_image" },
    ]);
  });

  it("publishes an approved, connected, ready post and persists the external id", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(approvedPost());

    await publishCreatorPost("org-a", "post-1");

    expect(provider.publishPost).toHaveBeenCalledTimes(1);
    const updateCall = unscopedPrismaMock.creatorPost.update.mock.calls.find(
      ([args]) => args.data.publishStatus === "PUBLISHED",
    );
    expect(updateCall![0].data.externalPostId).toBe("ext-post-1");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a" }),
      expect.objectContaining({ action: "creator.post.published" }),
    );
  });

  it("is idempotent: a claim that matches zero rows is a silent no-op (no double publish)", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(approvedPost());
    unscopedPrismaMock.creatorPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await publishCreatorPost("org-a", "post-1");

    expect(provider.publishPost).not.toHaveBeenCalled();
  });

  it("never publishes a post outside the caller's organization (tenant isolation)", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(null);

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow(PublishGuardError);
    expect(unscopedPrismaMock.creatorPost.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { id: "post-1", organizationId: "org-a" },
    });
    expect(provider.publishPost).not.toHaveBeenCalled();
  });

  it("refuses to publish an unapproved post even if it was scheduled", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(
      approvedPost({ approvalStatus: "PENDING_APPROVAL", approvedContentVersion: null }),
    );

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow(PublishGuardError);

    expect(provider.publishPost).not.toHaveBeenCalled();
    const failCall = unscopedPrismaMock.creatorPost.update.mock.calls.find(
      ([args]) => args.data.publishStatus === "FAILED",
    );
    expect(failCall![0].data.lastErrorCode).toBe("not_approved");
  });

  it("refuses to publish a post edited after approval (contentVersion drift)", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(
      approvedPost({ contentVersion: 2, approvedContentVersion: 1 }),
    );

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow(PublishGuardError);
    expect(provider.publishPost).not.toHaveBeenCalled();
  });

  it("refuses to publish a rejected post", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(
      approvedPost({ approvalStatus: "REJECTED" }),
    );

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow(PublishGuardError);
    expect(provider.publishPost).not.toHaveBeenCalled();
  });

  it("refuses to publish without a connected social account", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(
      approvedPost({
        socialAccount: { id: "acct-1", status: "NEEDS_REAUTH", accessTokenEnc: null },
      }),
    );

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow(PublishGuardError);
    expect(provider.publishPost).not.toHaveBeenCalled();
  });

  it("allows an AUTOPILOT campaign post within its rules", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(
      approvedPost({
        approvalStatus: "PENDING_APPROVAL",
        approvedContentVersion: null,
        campaignId: "camp-1",
        campaign: {
          approvalMode: "AUTOPILOT",
          autopilotEnabled: true,
          autopilotRules: {
            maxPostsPerWeek: 3,
            allowedPlatforms: ["INSTAGRAM"],
            allowedHoursStart: 0,
            allowedHoursEnd: 23,
            allowedLanguages: ["EN"],
          },
        },
      }),
    );
    unscopedPrismaMock.creatorPost.count.mockResolvedValue(0);

    await publishCreatorPost("org-a", "post-1");
    expect(provider.publishPost).toHaveBeenCalledTimes(1);
  });

  it("marks the post FAILED (not thrown-uncaught) with a sanitized message on a provider error", async () => {
    unscopedPrismaMock.creatorPost.findFirst.mockResolvedValue(approvedPost());
    provider.publishPost.mockRejectedValueOnce(new Error("raw upstream secret leak"));

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow();

    const failCall = unscopedPrismaMock.creatorPost.update.mock.calls.find(
      ([args]) => args.data.publishStatus === "FAILED",
    );
    expect(failCall![0].data.lastErrorSafe).not.toContain("raw upstream secret leak");
  });
});
