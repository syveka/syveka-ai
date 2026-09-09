import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { assertFeatureEnabled, isFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";
import { audit } from "./audit";
import type { CreateCampaignInput, AutopilotRules } from "@/lib/validators/creator-studio";

export const CREATOR_AUTOPILOT_FLAG = "creator_studio_autopilot";

export class CampaignError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createCreatorCampaign(ctx: TenantContext, input: CreateCampaignInput) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const campaign = await db.creatorCampaign.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name,
      objective: input.objective,
      targetPlatforms: input.targetPlatforms,
      targetLanguages: input.targetLanguages,
      targetPostsPerWeek: input.targetPostsPerWeek,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      approvalMode: input.approvalMode,
      createdById: ctx.userId,
    },
  });
  await audit(ctx, {
    action: "creator.campaign.create",
    resourceType: "creator_campaign",
    resourceId: campaign.id,
    after: { name: input.name, approvalMode: input.approvalMode },
  });
  return campaign;
}

export async function listCreatorCampaigns(ctx: TenantContext) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return tenantDb(ctx.orgId).creatorCampaign.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { posts: true } } },
  });
}

export async function getCreatorCampaign(ctx: TenantContext, id: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return tenantDb(ctx.orgId).creatorCampaign.findFirstOrThrow({
    where: { id },
    include: { posts: { orderBy: { createdAt: "desc" } } },
  });
}

/**
 * Autopilot must be opt-in (Phase 10) and is gated behind its own,
 * separately controllable feature flag ("creator_studio_autopilot") so an
 * org admin can disable unattended publishing platform-wide without
 * touching Creator Studio itself (Phase 18: "ability to disable autopilot
 * separately").
 */
export async function setCampaignAutopilot(
  ctx: TenantContext,
  campaignId: string,
  params: { enabled: boolean; rules?: AutopilotRules },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  if (params.enabled && !(await isFeatureEnabled(ctx.orgId, CREATOR_AUTOPILOT_FLAG))) {
    throw new CampaignError(
      "autopilot_flag_disabled",
      "Autopilot is not enabled for this organization.",
    );
  }
  const db = tenantDb(ctx.orgId);
  const campaign = await db.creatorCampaign.update({
    where: { id: campaignId },
    data: {
      autopilotEnabled: params.enabled,
      autopilotRules: params.enabled ? params.rules : undefined,
      approvalMode: params.enabled ? "AUTOPILOT" : "APPROVAL",
    },
  });
  await audit(ctx, {
    action: params.enabled
      ? "creator.campaign.autopilot_enabled"
      : "creator.campaign.autopilot_disabled",
    resourceType: "creator_campaign",
    resourceId: campaignId,
    after: { rules: params.rules },
  });
  return campaign;
}
