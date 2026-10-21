import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { getSocialPublishingProvider } from "@/server/social";
import { PublishOutcomeUnknownError } from "@/server/social/types";
import { enqueue } from "@/server/jobs/queue";
import { decryptSocialToken } from "@/server/integrations/social/crypto";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { isOrganizationActive } from "@/server/jobs/organization-guard";
import { audit } from "./audit";
import { notifyUser } from "./creator-notifications";
import { evaluateAutopilotRules } from "./creator-posts";
import type { AutopilotRules } from "@/lib/validators/creator-studio";

const REFERENCE_ASSETS_BUCKET = "creator-reference-assets";
const GENERATED_MEDIA_BUCKET = "creator-generated-media";
// Long enough to cover a real provider's full publish flow (e.g. Instagram's
// media-container processing, which can take up to ~2 minutes — see
// src/server/integrations/meta/client.ts), not just the initial upload.
const ASSET_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Signs a fetchable URL for a post's asset so a real SocialPublishingProvider
 * can hand it to the platform's API server-to-server (Meta and every other
 * real platform fetch media by URL rather than accepting an upload body).
 * Only this publishing engine knows which bucket an asset lives in
 * (UPLOAD → reference bucket, GENERATED → generated-media bucket) — a
 * provider never signs storage URLs itself.
 */
async function signAssetUrl(asset: { storagePath: string; source: string }): Promise<string> {
  const bucket = asset.source === "GENERATED" ? GENERATED_MEDIA_BUCKET : REFERENCE_ASSETS_BUCKET;
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrl(asset.storagePath, ASSET_SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new PublishGuardError("asset_sign_failed", "Failed to prepare media for publishing.");
  }
  return data.signedUrl;
}

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

// QStash may deliver a delayed message slightly early; only a clearly early job is skipped.
const EARLY_DELIVERY_TOLERANCE_MS = 60_000;

/**
 * A publish run can't outlive the job's time limit (300s, see
 * /api/v1/jobs/publish-creator-post), so a post still PUBLISHING this long
 * after its claim was interrupted: the function was stopped mid-publish.
 */
export const STALE_PUBLISHING_AFTER_MS = 330_000;
/** When the check for an interrupted run is delivered, after each claim. */
export const STALE_CHECK_DELAY_SECONDS = 600;

/**
 * FAILED posts that may already be live on the platform. They are never
 * claimed again automatically (a retry could post twice); a person checks the
 * platform and reschedules, which clears the code.
 */
export const NEEDS_REVIEW_ERROR_CODES = ["publish_outcome_unknown", "publish_interrupted"];

const OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether the platform published this post. Check the account before scheduling it again.";
const INTERRUPTED_MESSAGE =
  "Publishing was interrupted and the post may already be live. Check the account before scheduling it again.";

async function markPublished(postId: string, externalPostId: string): Promise<void> {
  await unscopedPrisma.creatorPost.update({
    where: { id: postId },
    data: {
      publishStatus: "PUBLISHED",
      externalPostId,
      publishedAt: new Date(),
      lastErrorCode: null,
      lastErrorSafe: null,
    },
  });
}

/**
 * Centralized publishing engine (Phase 13). Called by the
 * /api/v1/jobs/publish-creator-post handler — never call provider.publishPost
 * directly from anywhere else. Every guard below is re-verified here, at
 * publish time, regardless of what was checked when the post was scheduled
 * (Phase 12: "approval validation immediately before publish").
 */
export async function publishCreatorPost(
  orgId: string,
  postId: string,
): Promise<"done" | "organization_inactive"> {
  // A missing or soft-deleted organization publishes nothing; the post's
  // status is left as it is (nothing was attempted).
  if (!(await isOrganizationActive(orgId))) return "organization_inactive";

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

  // A job delivered before the post's current scheduled time belongs to an earlier schedule
  // (the post was rescheduled later); the job enqueued for the new time publishes it.
  if (post.scheduledFor && post.scheduledFor.getTime() > Date.now() + EARLY_DELIVERY_TOLERANCE_MS) {
    return "done";
  }

  // Idempotent claim: only a SCHEDULED or previously-FAILED post can start
  // publishing, and the conditional UPDATE (like the credit ledger's
  // reserve) makes a concurrent duplicate delivery a safe no-op rather than
  // a double-publish. A failure that may have published is never claimed.
  const claim = await unscopedPrisma.creatorPost.updateMany({
    where: {
      id: postId,
      organizationId: orgId,
      publishStatus: { in: ["SCHEDULED", "FAILED"] },
      OR: [
        { publishStatus: "SCHEDULED" },
        { lastErrorCode: null },
        { lastErrorCode: { notIn: NEEDS_REVIEW_ERROR_CODES } },
      ],
    },
    data: { publishStatus: "PUBLISHING", publishAttemptCount: { increment: 1 } },
  });
  if (claim.count !== 1) {
    return "done"; // already publishing/published/canceled/rejected — nothing to do
  }
  await scheduleStaleCheck(orgId, postId);

  // Set once the provider has published: from then on the post is live and must never be
  // marked FAILED, because a FAILED post can be claimed again and would be published twice.
  let externalPostId: string | null = null;
  try {
    if (post.publishStatus === "CANCELED" || post.approvalStatus === "REJECTED") {
      throw new PublishGuardError("not_publishable", "Post is canceled or rejected.");
    }

    // 4. Verify approval / autopilot authorization.
    // Only this organization's campaign can authorize autopilot: a post linked to another
    // organization's campaign (stored before campaign ids were checked) needs approval.
    if (
      post.campaign?.organizationId === orgId &&
      post.campaign.approvalMode === "AUTOPILOT" &&
      post.campaign.autopilotEnabled
    ) {
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
    // The relation has no organization constraint in the database: only an
    // account of this same organization may publish.
    if (
      !post.socialAccount ||
      post.socialAccount.organizationId !== orgId ||
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
    const assetUrls = await Promise.all(assets.map(signAssetUrl));
    // Last check before the external call (the claim and signing took time).
    if (!(await isOrganizationActive(orgId))) {
      throw new PublishGuardError("organization_inactive", "The organization is no longer active.");
    }
    const result = await provider.publishPost(
      {
        accessToken: decryptSocialToken(post.socialAccount.accessTokenEnc),
        externalAccountId: post.socialAccount.externalAccountId,
      },
      {
        caption: post.caption ?? "",
        hashtags: post.hashtags,
        assetStoragePaths: assets.map((a) => a.storagePath),
        assetUrls,
        mediaType,
      },
    );

    externalPostId = result.externalPostId;
    await markPublished(postId, externalPostId);

    await audit(ctx, {
      action: "creator.post.published",
      resourceType: "creator_post",
      resourceId: postId,
      after: { platform: post.platform, externalPostId: result.externalPostId },
    });
    // The post is live on the platform and can't be recalled: its record
    // above is kept either way. If the organization was deleted while the
    // provider call ran, nobody is notified.
    if (await isOrganizationActive(orgId)) {
      await notifyUser(ctx, post.createdById, {
        type: "creator_post_published",
        title: "Your post was published",
        href: "/creator-studio/calendar",
      });
    }
    return "done";
  } catch (error) {
    if (externalPostId === null && error instanceof PublishOutcomeUnknownError) {
      // Possibly live: recorded for a person to check, never retried (no throw).
      await unscopedPrisma.creatorPost.update({
        where: { id: postId },
        data: {
          publishStatus: "FAILED",
          lastErrorCode: "publish_outcome_unknown",
          lastErrorSafe: OUTCOME_UNKNOWN_MESSAGE,
        },
      });
      await recordNeedsReview(ctx, postId, "publish_outcome_unknown", OUTCOME_UNKNOWN_MESSAGE);
      return "done";
    }
    if (externalPostId !== null) {
      // Live on the platform; only the bookkeeping after it failed. Record it as published if
      // that write was what failed, and finish without a retry.
      console.error("creator post published, but recording it failed", {
        postId,
        orgId,
        externalPostId,
      });
      await markPublished(postId, externalPostId).catch(() => undefined);
      return "done";
    }
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
    // Deleted meanwhile: record the failure only; no notification, no retry.
    if (code === "organization_inactive" || !(await isOrganizationActive(orgId))) {
      return "organization_inactive";
    }
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

/**
 * After each claim, a delayed check finds a run that was stopped mid-publish
 * (recoverStalePublish). Without it, such a post stays PUBLISHING for good:
 * a redelivered job can't claim it. Failing to schedule the check doesn't
 * stop the publish; it is only needed if the run is also interrupted.
 */
async function scheduleStaleCheck(orgId: string, postId: string): Promise<void> {
  try {
    const claimed = await unscopedPrisma.creatorPost.findFirst({
      where: { id: postId, organizationId: orgId },
      select: { publishAttemptCount: true },
    });
    if (!claimed) return;
    await enqueue(
      "publish-creator-post",
      { orgId, postId, staleCheck: claimed.publishAttemptCount },
      {
        delaySeconds: STALE_CHECK_DELAY_SECONDS,
        deduplicationId: `publish-creator-post:stale-check:${postId}:${claimed.publishAttemptCount}`,
      },
    );
  } catch (error) {
    console.error("creator post stale-publish check not scheduled", { postId, orgId, error });
  }
}

/** Marks a possibly-live post FAILED for a person to check; audited and notified. */
async function recordNeedsReview(
  ctx: { orgId: string; userId: string },
  postId: string,
  code: "publish_outcome_unknown" | "publish_interrupted",
  safeMessage: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await audit(ctx, {
    action: `creator.post.${code}`,
    resourceType: "creator_post",
    resourceId: postId,
    actorType: "system",
    after: { errorCode: code, ...details },
  });
  if (await isOrganizationActive(ctx.orgId)) {
    await notifyUser(ctx, ctx.userId, {
      type: "creator_post_publish_failed",
      title: "Check whether your post was published",
      body: safeMessage,
      href: "/creator-studio/calendar",
    });
  }
}

/** The run being checked may still be running; the check is delivered again later. */
export class StaleCheckTooEarlyError extends Error {}

/**
 * Delayed check scheduled at each claim: if that same attempt is still
 * PUBLISHING well past the job's time limit, its run was stopped mid-publish.
 * Whether the platform published is unknown, so the post is never
 * re-published here: it is marked FAILED for a person to check
 * (publish_interrupted, never claimed again automatically). Only this
 * organization's post, and only the attempt that scheduled the check.
 */
export async function recoverStalePublish(
  orgId: string,
  postId: string,
  attempt: number,
): Promise<"recovered" | "done" | "organization_inactive"> {
  if (!(await isOrganizationActive(orgId))) return "organization_inactive";

  const post = await unscopedPrisma.creatorPost.findFirst({
    where: { id: postId, organizationId: orgId },
    select: { publishStatus: true, publishAttemptCount: true, createdById: true },
  });
  if (!post || post.publishStatus !== "PUBLISHING" || post.publishAttemptCount !== attempt) {
    return "done"; // that attempt finished, or a newer one owns the post
  }

  const recovered = await unscopedPrisma.creatorPost.updateMany({
    where: {
      id: postId,
      organizationId: orgId,
      publishStatus: "PUBLISHING",
      publishAttemptCount: attempt,
      updatedAt: { lt: new Date(Date.now() - STALE_PUBLISHING_AFTER_MS) },
    },
    data: {
      publishStatus: "FAILED",
      lastErrorCode: "publish_interrupted",
      lastErrorSafe: INTERRUPTED_MESSAGE,
    },
  });
  if (recovered.count !== 1) {
    // Still within the run's time limit (an early delivery), or it finished meanwhile.
    const current = await unscopedPrisma.creatorPost.findFirst({
      where: { id: postId, organizationId: orgId },
      select: { publishStatus: true, publishAttemptCount: true },
    });
    if (current?.publishStatus === "PUBLISHING" && current.publishAttemptCount === attempt) {
      throw new StaleCheckTooEarlyError("The publish attempt may still be running.");
    }
    return "done";
  }

  console.error("creator post publish was interrupted", { postId, orgId, attempt });
  await recordNeedsReview(
    { orgId, userId: post.createdById },
    postId,
    "publish_interrupted",
    INTERRUPTED_MESSAGE,
    { attempt },
  );
  return "recovered";
}
