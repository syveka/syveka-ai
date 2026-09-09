import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Service-level integration coverage (Phase 22) for the schedule -> publish
 * seam: schedulePost() (creator-posts.ts) and publishCreatorPost()
 * (creator-publishing.ts) are exercised together against ONE evolving mock
 * post record, proving the two services actually agree on post state
 * across the handoff — not just each in isolation. Prisma is mocked (no
 * live Postgres in this environment); this is not a full DB+RLS
 * integration test — see docs/creator-studio.md's test-readiness note.
 */

const {
  tenantDbMock,
  unscopedPrismaMock,
  auditMock,
  notifyUserMock,
  notifyApproversMock,
  enqueueMock,
  getSocialPublishingProviderMock,
  decryptSocialTokenMock,
} = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  unscopedPrismaMock: {} as Record<string, unknown>,
  auditMock: vi.fn(async () => undefined),
  notifyUserMock: vi.fn(async () => undefined),
  notifyApproversMock: vi.fn(async () => undefined),
  enqueueMock: vi.fn(async () => undefined),
  getSocialPublishingProviderMock: vi.fn(),
  decryptSocialTokenMock: vi.fn(() => "plain-token"),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: unscopedPrismaMock,
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-notifications", () => ({
  notifyUser: notifyUserMock,
  notifyApprovers: notifyApproversMock,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: enqueueMock }));
vi.mock("@/server/social", () => ({
  getSocialPublishingProvider: getSocialPublishingProviderMock,
}));
vi.mock("@/server/integrations/social/crypto", () => ({
  decryptSocialToken: decryptSocialTokenMock,
  encryptSocialToken: vi.fn((v: string) => `enc:${v}`),
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://storage.example/signed/asset.png" },
          error: null,
        }),
      }),
    },
  }),
}));

import { reviewCreatorPost, schedulePost } from "@/server/services/creator-posts";
import { publishCreatorPost } from "@/server/services/creator-publishing";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

describe("Creator Studio: approve -> schedule -> publish integration", () => {
  let post: Record<string, unknown>;
  let provider: { publishPost: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    post = {
      id: "post-1",
      organizationId: "org-a",
      createdById: "user-1",
      platform: "INSTAGRAM",
      caption: "hello",
      hashtags: ["#a"],
      assetIds: ["asset-1"],
      approvalStatus: "DRAFT",
      contentVersion: 1,
      approvedContentVersion: null,
      publishStatus: "NOT_SCHEDULED",
      campaignId: null,
      campaign: null,
      scheduledFor: null,
      socialAccountId: null,
      socialAccount: null,
      publishAttemptCount: 0,
    };

    provider = {
      publishPost: vi.fn(async () => ({ externalPostId: "ext-1", providerRequestId: "req-1" })),
    };
    getSocialPublishingProviderMock.mockReturnValue(provider);

    const tenantDb = {
      creatorPost: {
        findFirstOrThrow: vi.fn(async () => post),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(post, resolveIncrements(data));
          return post;
        }),
      },
      socialAccount: {
        findFirstOrThrow: vi.fn(async () => ({
          id: "acct-1",
          status: "CONNECTED",
          accessTokenEnc: "enc:token",
          externalAccountId: "ext-acct-1",
        })),
      },
    };
    tenantDbMock.mockReturnValue(tenantDb);

    unscopedPrismaMock.creatorPost = {
      findFirst: vi.fn(async () => ({
        ...post,
        socialAccount: post.socialAccountId
          ? {
              id: "acct-1",
              status: "CONNECTED",
              accessTokenEnc: "enc:token",
              externalAccountId: "ext-acct-1",
            }
          : null,
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { publishStatus: { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          if (!where.publishStatus.in.includes(post.publishStatus as string)) return { count: 0 };
          Object.assign(post, resolveIncrements(data));
          return { count: 1 };
        },
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(post, resolveIncrements(data));
        return post;
      }),
    };
    unscopedPrismaMock.creatorReferenceAsset = {
      findMany: vi.fn(async () => [
        { id: "asset-1", storagePath: "org-a/x.png", assetType: "generated_image" },
      ]),
    };
  });

  function resolveIncrements(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as object)) {
        out[key] = ((post[key] as number) ?? 0) + (value as { increment: number }).increment;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  it("carries a post through DRAFT -> APPROVED -> SCHEDULED -> PUBLISHED", async () => {
    await reviewCreatorPost(ctx(), "post-1", { decision: "APPROVE" });
    expect(post.approvalStatus).toBe("APPROVED");
    expect(post.approvedContentVersion).toBe(1);

    await schedulePost(ctx(), "post-1", {
      scheduledFor: new Date(Date.now() + 60_000),
      socialAccountId: "acct-1",
    });
    expect(post.publishStatus).toBe("SCHEDULED");
    expect(post.socialAccountId).toBe("acct-1");
    expect(enqueueMock).toHaveBeenCalledWith(
      "publish-creator-post",
      { orgId: "org-a", postId: "post-1" },
      expect.anything(),
    );

    await publishCreatorPost("org-a", "post-1");
    expect(post.publishStatus).toBe("PUBLISHED");
    expect(post.externalPostId).toBe("ext-1");
    expect(provider.publishPost).toHaveBeenCalledTimes(1);
  });

  it("a retry after a transient failure succeeds without double-charging attempt count oddly", async () => {
    await reviewCreatorPost(ctx(), "post-1", { decision: "APPROVE" });
    await schedulePost(ctx(), "post-1", {
      scheduledFor: new Date(Date.now() + 60_000),
      socialAccountId: "acct-1",
    });

    provider.publishPost.mockRejectedValueOnce(new Error("transient upstream error"));
    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow();
    expect(post.publishStatus).toBe("FAILED");
    expect(post.publishAttemptCount).toBe(1);

    // QStash retries by re-invoking the job handler; FAILED is reclaimable.
    await publishCreatorPost("org-a", "post-1");
    expect(post.publishStatus).toBe("PUBLISHED");
    expect(post.publishAttemptCount).toBe(2);
  });

  it("a rejected post can never reach PUBLISHED even if a schedule attempt is retried", async () => {
    await reviewCreatorPost(ctx(), "post-1", { decision: "REJECT" });
    expect(post.approvalStatus).toBe("REJECTED");

    await expect(
      schedulePost(ctx(), "post-1", {
        scheduledFor: new Date(Date.now() + 60_000),
        socialAccountId: "acct-1",
      }),
    ).rejects.toThrow();
    expect(post.publishStatus).toBe("NOT_SCHEDULED");
  });

  it("editing content after approval blocks publish until re-approved", async () => {
    await reviewCreatorPost(ctx(), "post-1", { decision: "APPROVE" });
    await schedulePost(ctx(), "post-1", {
      scheduledFor: new Date(Date.now() + 60_000),
      socialAccountId: "acct-1",
    });

    // Simulate a material content edit bumping the version without re-approval.
    post.contentVersion = 2;

    await expect(publishCreatorPost("org-a", "post-1")).rejects.toThrow();
    expect(post.publishStatus).toBe("FAILED");
    expect(provider.publishPost).not.toHaveBeenCalled();
  });
});
