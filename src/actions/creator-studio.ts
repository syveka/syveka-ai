"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import {
  createCreatorProfile,
  createReferenceAssetUploadUrl,
  confirmReferenceAsset,
  confirmCreatorConsent,
} from "@/server/services/creator-profiles";
import {
  requestCharacterImageGeneration,
  requestImageFromCharacterGeneration,
  requestVideoFromImageGeneration,
  requestCaptionGeneration,
} from "@/server/services/creator-generations";
import { createCreatorCampaign, setCampaignAutopilot } from "@/server/services/creator-campaigns";
import { creatorActionError } from "@/server/services/creator-studio-action-errors";
import {
  createCreatorPost,
  updatePostContent,
  requestPostApproval,
  reviewCreatorPost,
  schedulePost,
  cancelScheduledPost,
} from "@/server/services/creator-posts";
import {
  connectSocialAccount,
  disconnectSocialAccount,
  startMetaOAuthUrl,
  SocialConnectError,
} from "@/server/services/creator-social-accounts";
import {
  createCreatorProfileSchema,
  referenceAssetUploadUrlSchema,
  generateCharacterImageSchema,
  generateImageFromCharacterSchema,
  generateVideoFromImageSchema,
  generateCaptionSchema,
  createCampaignSchema,
  setAutopilotSchema,
  createPostSchema,
  updatePostContentSchema,
  reviewPostSchema,
  schedulePostSchema,
  connectSocialAccountSchema,
} from "@/lib/validators/creator-studio";

export type CreatorActionState = { error?: string; id?: string };

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "invalid_input";
}

export async function createCreatorProfileAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  const limited = await limitError(ctx, "api", "creator-profiles-create");
  if (limited) return { error: limited };
  const parsed = createCreatorProfileSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const profile = await createCreatorProfile(ctx, parsed.data);
  revalidatePath("/creator-studio/characters");
  return { id: profile.id };
}

export async function createReferenceAssetUploadUrlAction(
  profileId: string,
  payload: unknown,
): Promise<{ error?: string; uploadIntentId?: string; signedUrl?: string }> {
  const ctx = await requirePermission("creator:write");
  const limited = await limitError(ctx, "api", "creator-reference-upload-url");
  if (limited) return { error: limited };
  const parsed = referenceAssetUploadUrlSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await createReferenceAssetUploadUrl(ctx, profileId, parsed.data);
  return { uploadIntentId: result.uploadIntentId, signedUrl: result.signedUrl };
}

export async function confirmReferenceAssetAction(
  profileId: string,
  uploadIntentId: string,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  const asset = await confirmReferenceAsset(ctx, profileId, uploadIntentId);
  revalidatePath(`/creator-studio/characters/${profileId}`);
  return { id: asset.id };
}

export async function confirmConsentAction(profileId: string): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  try {
    await confirmCreatorConsent(ctx, profileId);
  } catch (e) {
    return { error: creatorActionError(e, "failed") };
  }
  revalidatePath(`/creator-studio/characters/${profileId}`);
  return {};
}

/**
 * The limit an action shares with its /api/v1/creator-studio route (same limiter and key, so
 * the two entry points draw on one allowance), failing closed. Generations use the per-user
 * creatorGenerate limit: each is a paid provider call, whichever entry point starts it.
 */
async function limitError(
  ctx: { orgId: string; userId: string },
  limiter: "creatorGenerate" | "creatorPostWorkflow" | "api",
  routeKey?: string,
): Promise<"rate_limited" | "service_unavailable" | null> {
  const { actionRateLimitError } = await import("@/server/security/rate-limit");
  const key = routeKey ? `${routeKey}:${ctx.orgId}:${ctx.userId}` : `${ctx.orgId}:${ctx.userId}`;
  return actionRateLimitError([limiter, key]);
}

export async function generateCharacterImageAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:generate");
  const parsed = generateCharacterImageSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const limited = await limitError(ctx, "creatorGenerate");
  if (limited) return { error: limited };
  try {
    const { generation } = await requestCharacterImageGeneration(ctx, parsed.data);
    revalidatePath("/creator-studio/library");
    return { id: generation.id };
  } catch (e) {
    return { error: creatorActionError(e, "generation_failed") };
  }
}

export async function generateImageFromCharacterAction(
  payload: unknown,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:generate");
  const parsed = generateImageFromCharacterSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const limited = await limitError(ctx, "creatorGenerate");
  if (limited) return { error: limited };
  try {
    const { generation } = await requestImageFromCharacterGeneration(ctx, parsed.data);
    revalidatePath("/creator-studio/library");
    return { id: generation.id };
  } catch (e) {
    return { error: creatorActionError(e, "generation_failed") };
  }
}

export async function generateVideoFromImageAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:generate");
  const parsed = generateVideoFromImageSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const limited = await limitError(ctx, "creatorGenerate");
  if (limited) return { error: limited };
  try {
    const { generation } = await requestVideoFromImageGeneration(ctx, parsed.data);
    revalidatePath("/creator-studio/library");
    return { id: generation.id };
  } catch (e) {
    return { error: creatorActionError(e, "generation_failed") };
  }
}

export async function generateCaptionAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:generate");
  const parsed = generateCaptionSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const limited = await limitError(ctx, "creatorGenerate");
  if (limited) return { error: limited };
  try {
    const { generation } = await requestCaptionGeneration(ctx, parsed.data);
    revalidatePath("/creator-studio/library");
    return { id: generation.id };
  } catch (e) {
    return { error: creatorActionError(e, "generation_failed") };
  }
}

export async function createCampaignAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  const limited = await limitError(ctx, "api", "creator-campaigns-create");
  if (limited) return { error: limited };
  const parsed = createCampaignSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const campaign = await createCreatorCampaign(ctx, parsed.data);
  revalidatePath("/creator-studio/campaigns");
  return { id: campaign.id };
}

export async function setCampaignAutopilotAction(
  campaignId: string,
  payload: unknown,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:manage-autopilot");
  const parsed = setAutopilotSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    await setCampaignAutopilot(ctx, campaignId, parsed.data);
  } catch (e) {
    return { error: creatorActionError(e, "failed") };
  }
  revalidatePath(`/creator-studio/campaigns/${campaignId}`);
  return {};
}

export async function createCreatorPostAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  const limited = await limitError(ctx, "api", "creator-posts-create");
  if (limited) return { error: limited };
  const parsed = createPostSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const post = await createCreatorPost(ctx, parsed.data);
  revalidatePath("/creator-studio/library");
  return { id: post.id };
}

export async function updatePostContentAction(
  postId: string,
  payload: unknown,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  const parsed = updatePostContentSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    await updatePostContent(ctx, postId, parsed.data);
  } catch (e) {
    return { error: creatorActionError(e, "failed") };
  }
  revalidatePath("/creator-studio/library");
  revalidatePath("/creator-studio/approvals");
  return {};
}

export async function requestPostApprovalAction(postId: string): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:write");
  const limited = await limitError(ctx, "creatorPostWorkflow");
  if (limited) return { error: limited };
  await requestPostApproval(ctx, postId);
  revalidatePath("/creator-studio/approvals");
  revalidatePath("/creator-studio/library");
  return {};
}

export async function reviewCreatorPostAction(
  postId: string,
  payload: unknown,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:approve");
  const limited = await limitError(ctx, "creatorPostWorkflow");
  if (limited) return { error: limited };
  const parsed = reviewPostSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  await reviewCreatorPost(ctx, postId, parsed.data);
  revalidatePath("/creator-studio/approvals");
  revalidatePath("/creator-studio/calendar");
  return {};
}

export async function schedulePostAction(
  postId: string,
  payload: unknown,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:publish");
  const limited = await limitError(ctx, "creatorPostWorkflow");
  if (limited) return { error: limited };
  const parsed = schedulePostSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    await schedulePost(ctx, postId, parsed.data);
  } catch (e) {
    return { error: creatorActionError(e, "failed") };
  }
  revalidatePath("/creator-studio/calendar");
  return {};
}

export async function cancelScheduledPostAction(postId: string): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:publish");
  await cancelScheduledPost(ctx, postId);
  revalidatePath("/creator-studio/calendar");
  return {};
}

export async function connectSocialAccountAction(payload: unknown): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:manage-social-accounts");
  const limited = await limitError(ctx, "api", "creator-social-connect");
  if (limited) return { error: limited };
  const parsed = connectSocialAccountSchema.safeParse(payload);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    const account = await connectSocialAccount(ctx, parsed.data);
    revalidatePath("/creator-studio/social-accounts");
    return { id: account.id };
  } catch (e) {
    return { error: creatorActionError(e, "connect_failed") };
  }
}

export async function disconnectSocialAccountAction(
  accountId: string,
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:manage-social-accounts");
  const limited = await limitError(ctx, "creatorPostWorkflow");
  if (limited) return { error: limited };
  await disconnectSocialAccount(ctx, accountId);
  revalidatePath("/creator-studio/social-accounts");
  return {};
}

/** Redirects the browser to Meta's OAuth dialog for real Instagram/Facebook publishing. */
export async function startMetaOAuthAction(
  platform: "INSTAGRAM" | "FACEBOOK",
): Promise<CreatorActionState> {
  const ctx = await requirePermission("creator:manage-social-accounts");
  let url: string;
  try {
    url = startMetaOAuthUrl(ctx, platform);
  } catch (e) {
    return { error: e instanceof SocialConnectError ? e.code : "connect_failed" };
  }
  redirect(url);
}
