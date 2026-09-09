import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, auditMock, notifyApproversMock, notifyUserMock, enqueueMock } = vi.hoisted(
  () => ({
    tenantDbMock: vi.fn(),
    auditMock: vi.fn(async () => undefined),
    notifyApproversMock: vi.fn(async () => undefined),
    notifyUserMock: vi.fn(async () => undefined),
    enqueueMock: vi.fn(async () => undefined),
  }),
);

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock, unscopedPrisma: {} }));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-notifications", () => ({
  notifyApprovers: notifyApproversMock,
  notifyUser: notifyUserMock,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: enqueueMock }));

import {
  updatePostContent,
  reviewCreatorPost,
  schedulePost,
  evaluateAutopilotRules,
  PostWorkflowError,
} from "@/server/services/creator-posts";
import type { AutopilotRules } from "@/lib/validators/creator-studio";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

function basePost(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    organizationId: "org-a",
    approvalStatus: "DRAFT",
    publishStatus: "NOT_SCHEDULED",
    contentVersion: 1,
    approvedContentVersion: null,
    createdById: "user-1",
    caption: "old",
    ...overrides,
  };
}

describe("Creator Studio approval state machine", () => {
  let db: {
    creatorPost: {
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    socialAccount: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      creatorPost: {
        findFirstOrThrow: vi.fn(async () => basePost()),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...basePost(),
          ...data,
        })),
      },
      socialAccount: {
        findFirstOrThrow: vi.fn(async () => ({ id: "acct-1", status: "CONNECTED" })),
      },
    };
    tenantDbMock.mockReturnValue(db);
  });

  it("approving a post stamps approvedContentVersion to the current content version", async () => {
    await reviewCreatorPost(ctx(), "post-1", { decision: "APPROVE" });

    const data = db.creatorPost.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      approvalStatus: "APPROVED",
      approvedById: "user-1",
      approvedContentVersion: 1,
    });
  });

  it("rejecting and requesting changes set the corresponding status without approving", async () => {
    await reviewCreatorPost(ctx(), "post-1", { decision: "REJECT" });
    expect(db.creatorPost.update.mock.calls[0]![0].data.approvalStatus).toBe("REJECTED");

    await reviewCreatorPost(ctx(), "post-1", { decision: "REQUEST_CHANGES" });
    expect(db.creatorPost.update.mock.calls[1]![0].data.approvalStatus).toBe("CHANGES_REQUESTED");
  });

  it("a material edit after approval bumps contentVersion and re-requires approval", async () => {
    db.creatorPost.findFirstOrThrow.mockResolvedValueOnce(
      basePost({ approvalStatus: "APPROVED", approvedContentVersion: 1 }),
    );

    await updatePostContent(ctx(), "post-1", { caption: "new caption" });

    const data = db.creatorPost.update.mock.calls[0]![0].data;
    expect(data.contentVersion).toEqual({ increment: 1 });
    expect(data.approvalStatus).toBe("PENDING_APPROVAL");
  });

  it("editing a DRAFT post does not touch contentVersion or approvalStatus", async () => {
    db.creatorPost.findFirstOrThrow.mockResolvedValueOnce(basePost({ approvalStatus: "DRAFT" }));

    await updatePostContent(ctx(), "post-1", { caption: "new caption" });

    const data = db.creatorPost.update.mock.calls[0]![0].data;
    expect(data.contentVersion).toBeUndefined();
    expect(data.approvalStatus).toBeUndefined();
  });

  it("refuses to edit a post that is already published", async () => {
    db.creatorPost.findFirstOrThrow.mockResolvedValueOnce(basePost({ publishStatus: "PUBLISHED" }));

    await expect(updatePostContent(ctx(), "post-1", { caption: "x" })).rejects.toThrow(
      PostWorkflowError,
    );
  });

  it("refuses to schedule a rejected post", async () => {
    db.creatorPost.findFirstOrThrow.mockResolvedValueOnce(basePost({ approvalStatus: "REJECTED" }));

    await expect(
      schedulePost(ctx(), "post-1", { scheduledFor: new Date(), socialAccountId: "acct-1" }),
    ).rejects.toThrow(PostWorkflowError);
  });

  it("refuses to schedule against a disconnected social account", async () => {
    db.socialAccount.findFirstOrThrow.mockResolvedValueOnce({
      id: "acct-1",
      status: "DISCONNECTED",
    });

    await expect(
      schedulePost(ctx(), "post-1", { scheduledFor: new Date(), socialAccountId: "acct-1" }),
    ).rejects.toThrow(PostWorkflowError);
  });

  it("scheduling enqueues the publish job with a version-scoped dedup key (idempotency)", async () => {
    await schedulePost(ctx(), "post-1", {
      scheduledFor: new Date(Date.now() + 60_000),
      socialAccountId: "acct-1",
    });

    expect(enqueueMock).toHaveBeenCalledWith(
      "publish-creator-post",
      { orgId: "org-a", postId: "post-1" },
      expect.objectContaining({ deduplicationId: expect.stringContaining("post-1") }),
    );
  });
});

describe("evaluateAutopilotRules", () => {
  const rules: AutopilotRules = {
    maxPostsPerWeek: 3,
    allowedPlatforms: ["INSTAGRAM", "FACEBOOK"],
    allowedTemplateCategories: [],
    allowedHoursStart: 8,
    allowedHoursEnd: 20,
    allowedLanguages: ["EN"],
  };

  function base(overrides: Partial<Parameters<typeof evaluateAutopilotRules>[0]> = {}) {
    return {
      approvalMode: "AUTOPILOT" as const,
      autopilotEnabled: true,
      rules,
      platform: "INSTAGRAM" as const,
      scheduledFor: new Date(Date.UTC(2026, 0, 1, 12, 0)),
      postsThisWeek: 0,
      postsThisMonth: 0,
      ...overrides,
    };
  }

  it("allows a compliant post", () => {
    expect(evaluateAutopilotRules(base())).toEqual({ allowed: true });
  });

  it("blocks when autopilot is not enabled on the campaign", () => {
    const result = evaluateAutopilotRules(base({ autopilotEnabled: false }));
    expect(result).toEqual({ allowed: false, reason: "autopilot_not_enabled" });
  });

  it("blocks a platform outside the allowed list", () => {
    const result = evaluateAutopilotRules(base({ platform: "TIKTOK" as never }));
    expect(result).toEqual({ allowed: false, reason: "platform_not_allowed" });
  });

  it("blocks a time outside allowed publishing hours", () => {
    const result = evaluateAutopilotRules(
      base({ scheduledFor: new Date(Date.UTC(2026, 0, 1, 3, 0)) }),
    );
    expect(result).toEqual({ allowed: false, reason: "outside_allowed_hours" });
  });

  it("blocks once the weekly cap is reached", () => {
    const result = evaluateAutopilotRules(base({ postsThisWeek: 3 }));
    expect(result).toEqual({ allowed: false, reason: "weekly_limit_reached" });
  });

  it("blocks once the monthly cap is reached", () => {
    const result = evaluateAutopilotRules(
      base({ rules: { ...rules, monthlyContentLimit: 10 }, postsThisMonth: 10 }),
    );
    expect(result).toEqual({ allowed: false, reason: "monthly_limit_reached" });
  });

  it("blocks when no rules are configured at all", () => {
    const result = evaluateAutopilotRules(base({ rules: null }));
    expect(result).toEqual({ allowed: false, reason: "no_autopilot_rules" });
  });
});
