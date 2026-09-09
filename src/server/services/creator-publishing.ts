import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { getSocialPublishingProvider } from "@/server/social";
import { decryptSocialToken } from "@/server/integrations/social/crypto";
import { audit } from "./audit";
import { notifyUser } from "./creator-notifications";
import { evaluateAutopilotRules } from "./creator-posts";
import type { AutopilotRules } from "@/lib/validators/creator-studio";

export class PublishGuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function startOfWeek(from: Date): Date {
  const d = new Date(from);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday-anchored
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(from: Date): Date {
  const d = new Date(from);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Centralized publishing engine (Phase 13). Called by the
 * /api/v1/jobs/publish-creator-post handler — never call provider.publishPost
 * directly from anywhere else. Every guard below is re-verified here, at
 * publish time, regardless of what was checked when the post was scheduled
 * (Phase 12: "approval validation immediately before publish").
 */
export async function publishCreatorPost(orgId: string, postId: string): Promise<void> {
  // 1-2. Resolve organization + post, verifying tenant ownership via the
  // explicit organizationId filter (never trust the caller's orgId alone).
  const post = await unscopedPrisma.creatorPost.findFirst({
    where: { id: postId, organizationId: orgId },
    include: { campaign: true, socialAccount: true },
  });
  if (!post) {
    throw new PublishGuardError("post_not_found", "Post not found for this organization.");
  }

  const ctx = { orgId, userId: post.createdById };

  // Idempotent claim: only a SCHEDULED or previously-FAILED post can start
  // publishing, and the conditional UPDATE (like the credit ledger's
  // reserve) makes a concurrent duplicate delivery a safe no-op rather than
  // a double-publish.
  const claim = await unscopedPrisma.creatorPost.updateMany({
    where: { id: postId, organizationId: orgId, publishStatus: { in: ["SCHEDULED", "FAILED"] } },
    data: { publishStatus: "PUBLISHING", publishAttemptCount: { increment: 1 } },
  });
  if (claim.count !== 1) {
    return; // already publishing/published/canceled/rejected — nothing to do
  }

  try {
    if (post.publishStatus === "CANCELED" || post.approvalStatus === "REJECTED") {
      throw new PublishGuardError("not_publishable", "Post is canceled or rejected.");
    }

    // 4. Verify approval / autopilot authorization.
    if (post.campaign?.approvalMode === "AUTOPILOT" && post.campaign.autopilotEnabled) {
      const [postsThisWeek, postsThisMonth] = await Promise.all([
        unscopedPrisma.creatorPost.count({
          where: {
            organizationId: orgId,
            campaignId: post.campaignId,
            publishStatus: "PUBLISHED",
            publishedAt: { gte: startOfWeek(new Date()) },
          },
        }),
        unscopedPrisma.creatorPost.count({
          where: {
            organizationId: orgId,
            campaignId: post.campaignId,
            publishStatus: "PUBLISHED",
            publishedAt: { gte: startOfMonth(new Date()) },
          },
        }),
      ]);
      const decision = evaluateAutopilotRules({
        approvalMode: post.campaign.approvalMode,
        autopilotEnabled: post.campaign.autopilotEnabled,
        rules: (post.campaign.autopilotRules as AutopilotRules | null) ?? null,
        platform: post.platform,
        scheduledFor: post.scheduledFor ?? new Date(),
        postsThisWeek,
        postsThisMonth,
      });
      if (!decision.allowed) {
        throw new PublishGuardError(
          decision.reason,
          `Autopilot rule violation: ${decision.reason}`,
        );
      }
    } else if (
      post.approvalStatus !== "APPROVED" ||
      post.approvedContentVersion !== post.contentVersion
    ) {
      throw new PublishGuardError(
        "not_approved",
        "Post is not approved for its current content version.",
      );
    }

    // 6. Verify social connection.
    if (
      !post.socialAccount ||
      post.socialAccount.status !== "CONNECTED" ||
      !post.socialAccount.accessTokenEnc
    ) {
      throw new PublishGuardError(
        "social_account_not_connected",
        "Social account is not connected.",
      );
    }

    // 7. Verify media readiness.
    if (post.assetIds.length === 0) {
      throw new PublishGuardError("no_media", "Post has no media assets.");
    }
    const assets = await unscopedPrisma.creatorReferenceAsset.findMany({
      where: { id: { in: post.assetIds }, organizationId: orgId },
    });
    if (assets.length !== post.assetIds.length) {
      throw new PublishGuardError("media_missing", "One or more post assets could not be found.");
    }

    // 8-9. Publish + persist external id.
    const provider = getSocialPublishingProvider(post.platform);
    const mediaType = assets[0]!.assetType.includes("video") ? "video" : "image";
    const result = await provider.publishPost(
      {
        accessToken: decryptSocialToken(post.socialAccount.accessTokenEnc),
        externalAccountId: post.socialAccount.externalAccountId,
      },
      {
        caption: post.caption ?? "",
        hashtags: post.hashtags,
        assetStoragePaths: assets.map((a) => a.storagePath),
        mediaType,
      },
    );

    await unscopedPrisma.creatorPost.update({
      where: { id: postId },
      data: {
        publishStatus: "PUBLISHED",
        externalPostId: result.externalPostId,
        publishedAt: new Date(),
        lastErrorCode: null,
        lastErrorSafe: null,
      },
    });

    await audit(ctx, {
      action: "creator.post.published",
      resourceType: "creator_post",
      resourceId: postId,
      after: { platform: post.platform, externalPostId: result.externalPostId },
    });
    await notifyUser(ctx, post.createdById, {
      type: "creator_post_published",
      title: "Your post was published",
      href: "/creator-studio/calendar",
    });
  } catch (error) {
    const code = error instanceof PublishGuardError ? error.code : "publish_failed";
    const safeMessage =
      error instanceof PublishGuardError
        ? error.message
        : "Publishing failed due to a provider error. Please try again.";
    if (!(error instanceof PublishGuardError)) {
      console.error("creator post publish failed", { postId, orgId, error });
    }

    await unscopedPrisma.creatorPost.update({
      where: { id: postId },
      data: { publishStatus: "FAILED", lastErrorCode: code, lastErrorSafe: safeMessage },
    });
    await audit(ctx, {
      action: "creator.post.publish_failed",
      resourceType: "creator_post",
      resourceId: postId,
      after: { errorCode: code },
    });
    await notifyUser(ctx, post.createdById, {
      type: "creator_post_publish_failed",
      title: "Publishing failed",
      body: safeMessage,
      href: "/creator-studio/calendar",
    });
    throw error; // let the job handler decide on QStash retry vs. terminal failure
  }
}
