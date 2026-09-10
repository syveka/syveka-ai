import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";
import { audit } from "./audit";
import { notifyApprovers, notifyUser } from "./creator-notifications";
import { enqueue } from "@/server/jobs/queue";
import type { CreatePostInput, AutopilotRules } from "@/lib/validators/creator-studio";
import type { CreatorCampaignApprovalMode, SocialPlatform } from "@prisma/client";

export class PostWorkflowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createCreatorPost(ctx: TenantContext, input: CreatePostInput) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const post = await db.creatorPost.create({
    data: {
      organizationId: ctx.orgId,
      campaignId: input.campaignId,
      creatorProfileId: input.creatorProfileId,
      assetIds: input.assetIds,
      caption: input.caption,
      hashtags: input.hashtags,
      platform: input.platform,
      approvalStatus: "DRAFT",
      createdById: ctx.userId,
    },
  });
  await audit(ctx, {
    action: "creator.post.create",
    resourceType: "creator_post",
    resourceId: post.id,
    after: { platform: input.platform, campaignId: input.campaignId },
  });
  return post;
}

export async function listCreatorPosts(
  ctx: TenantContext,
  filters: {
    campaignId?: string;
    approvalStatus?: string;
    publishStatus?: string;
    platform?: SocialPlatform;
  } = {},
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  return db.creatorPost.findMany({
    where: {
      ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      ...(filters.approvalStatus ? { approvalStatus: filters.approvalStatus as never } : {}),
      ...(filters.publishStatus ? { publishStatus: filters.publishStatus as never } : {}),
      ...(filters.platform ? { platform: filters.platform } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function getCreatorPost(ctx: TenantContext, id: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return tenantDb(ctx.orgId).creatorPost.findFirstOrThrow({ where: { id } });
}

/**
 * A material content edit after approval invalidates the approval (Phase
 * 10) — bumping contentVersion and resetting approvalStatus so a scheduled
 * job can never publish edited-but-unapproved content
 * (approvedContentVersion !== contentVersion is checked at publish time).
 */
export async function updatePostContent(
  ctx: TenantContext,
  postId: string,
  input: { caption?: string; hashtags?: string[]; assetIds?: string[] },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const post = await db.creatorPost.findFirstOrThrow({ where: { id: postId } });
  if (post.publishStatus === "PUBLISHED" || post.publishStatus === "PUBLISHING") {
    throw new PostWorkflowError(
      "already_published",
      "Cannot edit a post that is already published.",
    );
  }

  const wasApproved = post.approvalStatus === "APPROVED";
  const updated = await db.creatorPost.update({
    where: { id: postId },
    data: {
      ...input,
      contentVersion: wasApproved ? { increment: 1 } : undefined,
      approvalStatus: wasApproved ? "PENDING_APPROVAL" : undefined,
    },
  });
  await audit(ctx, {
    action: "creator.post.content_updated",
    resourceType: "creator_post",
    resourceId: postId,
    after: { contentVersion: updated.contentVersion, reApprovalRequired: wasApproved },
  });
  return updated;
}

export async function requestPostApproval(ctx: TenantContext, postId: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const post = await db.creatorPost.update({
    where: { id: postId },
    data: { approvalStatus: "PENDING_APPROVAL" },
  });
  await audit(ctx, {
    action: "creator.post.approval_requested",
    resourceType: "creator_post",
    resourceId: postId,
  });
  await notifyApprovers(ctx, {
    type: "creator_post_pending_approval",
    title: "A post is awaiting your approval",
    href: `/creator-studio/approvals`,
  });
  return post;
}

export async function reviewCreatorPost(
  ctx: TenantContext,
  postId: string,
  params: { decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES"; note?: string },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const post = await db.creatorPost.findFirstOrThrow({ where: { id: postId } });

  const data =
    params.decision === "APPROVE"
      ? {
          approvalStatus: "APPROVED" as const,
          approvedById: ctx.userId,
          approvedAt: new Date(),
          approvedContentVersion: post.contentVersion,
        }
      : params.decision === "REJECT"
        ? { approvalStatus: "REJECTED" as const }
        : { approvalStatus: "CHANGES_REQUESTED" as const };

  const updated = await db.creatorPost.update({ where: { id: postId }, data });
  await audit(ctx, {
    action: `creator.post.${params.decision.toLowerCase()}`,
    resourceType: "creator_post",
    resourceId: postId,
    after: { note: params.note },
  });
  await notifyUser(ctx, post.createdById, {
    type: `creator_post_${params.decision.toLowerCase()}`,
    title:
      params.decision === "APPROVE"
        ? "Your post was approved"
        : params.decision === "REJECT"
          ? "Your post was rejected"
          : "Changes were requested on your post",
    href: `/creator-studio/library`,
  });
  return updated;
}

/**
 * Phase 12: schedules a post for publish. Approval/autopilot authorization
 * itself is re-verified immediately before publish (see
 * creator-publishing.ts's publishCreatorPost) — this only records intent
 * and enqueues the delayed job; it never bypasses that final check.
 */
export async function schedulePost(
  ctx: TenantContext,
  postId: string,
  params: { scheduledFor: Date; socialAccountId: string },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const post = await db.creatorPost.findFirstOrThrow({ where: { id: postId } });

  if (post.approvalStatus === "REJECTED") {
    throw new PostWorkflowError("post_rejected", "A rejected post cannot be scheduled.");
  }

  const account = await db.socialAccount.findFirstOrThrow({
    where: { id: params.socialAccountId },
  });
  if (account.status !== "CONNECTED") {
    throw new PostWorkflowError(
      "social_account_not_connected",
      "The selected social account is not connected.",
    );
  }

  const now = Date.now();
  const delaySeconds = Math.max(0, Math.round((params.scheduledFor.getTime() - now) / 1000));

  const updated = await db.creatorPost.update({
    where: { id: postId },
    data: {
      scheduledFor: params.scheduledFor,
      socialAccountId: params.socialAccountId,
      publishStatus: "SCHEDULED",
    },
  });

  await enqueue(
    "publish-creator-post",
    { orgId: ctx.orgId, postId },
    { delaySeconds, deduplicationId: `publish-creator-post:${postId}:${updated.contentVersion}` },
  );

  await audit(ctx, {
    action: "creator.post.scheduled",
    resourceType: "creator_post",
    resourceId: postId,
    after: { scheduledFor: params.scheduledFor, socialAccountId: params.socialAccountId },
  });
  return updated;
}

export async function cancelScheduledPost(ctx: TenantContext, postId: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const updated = await db.creatorPost.update({
    where: { id: postId },
    data: { publishStatus: "CANCELED" },
  });
  await audit(ctx, {
    action: "creator.post.canceled",
    resourceType: "creator_post",
    resourceId: postId,
  });
  return updated;
}

/**
 * Autopilot rule evaluation (Phase 10). Only consulted when the owning
 * campaign has autopilotEnabled — a manually-approved post never runs
 * through this. Every check failure is a distinct, reportable reason so a
 * blocked publish attempt is auditable, not a silent no-op.
 */
export function evaluateAutopilotRules(params: {
  approvalMode: CreatorCampaignApprovalMode;
  autopilotEnabled: boolean;
  rules: AutopilotRules | null;
  platform: SocialPlatform;
  scheduledFor: Date;
  postsThisWeek: number;
  postsThisMonth: number;
}): { allowed: true } | { allowed: false; reason: string } {
  if (params.approvalMode !== "AUTOPILOT" || !params.autopilotEnabled) {
    return { allowed: false, reason: "autopilot_not_enabled" };
  }
  if (!params.rules) return { allowed: false, reason: "no_autopilot_rules" };

  if (!params.rules.allowedPlatforms.includes(params.platform)) {
    return { allowed: false, reason: "platform_not_allowed" };
  }
  const hour = params.scheduledFor.getUTCHours();
  if (hour < params.rules.allowedHoursStart || hour > params.rules.allowedHoursEnd) {
    return { allowed: false, reason: "outside_allowed_hours" };
  }
  if (params.postsThisWeek >= params.rules.maxPostsPerWeek) {
    return { allowed: false, reason: "weekly_limit_reached" };
  }
  if (
    params.rules.monthlyContentLimit !== undefined &&
    params.postsThisMonth >= params.rules.monthlyContentLimit
  ) {
    return { allowed: false, reason: "monthly_limit_reached" };
  }
  return { allowed: true };
}
