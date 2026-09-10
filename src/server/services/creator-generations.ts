import "server-only";

import type { CreatorGenerationType, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG, CreatorProfileError } from "./creator-profiles";
import { audit } from "./audit";
import {
  getCreatorGenerationCreditCost,
  reserveCreatorCredits,
  commitCreatorCredits,
  releaseCreatorCredits,
  InsufficientCreditsError,
} from "./creator-credits";
import { getCreatorMediaProvider, getCreatorCaptionProvider } from "@/server/ai/creator";
import type { AspectRatio, GenerationQuality, CaptionLanguage } from "@/server/ai/creator";
import { getBusinessDnaContext, buildBusinessDnaPromptBlock } from "@/server/business-dna/context";
import { MIN_REFERENCE_ASSETS } from "@/lib/validators/creator-studio";

type GenerationExecution = {
  outputAssetIds: string[];
  output?: Prisma.InputJsonValue;
  providerRequestId: string;
  latencyMs: number;
};

/**
 * Shared reserve → execute → commit/release orchestration (Phase 2 + 13).
 * Every capability below goes through this so credit accounting, audit
 * logging, and error handling never drift between generation types.
 */
async function runGeneration(
  ctx: TenantContext,
  params: {
    generationType: CreatorGenerationType;
    provider: string;
    model: string;
    prompt: string;
    negativePrompt?: string;
    creatorProfileId?: string;
    templateId?: string;
    inputAssetIds: string[];
    creditCost: number;
    execute: () => Promise<GenerationExecution>;
  },
) {
  const db = tenantDb(ctx.orgId);

  const generation = await db.creatorGeneration.create({
    data: {
      organizationId: ctx.orgId,
      creatorProfileId: params.creatorProfileId,
      generationType: params.generationType,
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      templateId: params.templateId,
      inputAssetIds: params.inputAssetIds,
      status: "QUEUED",
      creditsReserved: params.creditCost,
      createdById: ctx.userId,
    },
  });

  try {
    await reserveCreatorCredits(ctx, { generationId: generation.id, amount: params.creditCost });
  } catch (error) {
    const errorCode =
      error instanceof InsufficientCreditsError ? "insufficient_credits" : "reserve_failed";
    await db.creatorGeneration.update({
      where: { id: generation.id },
      data: {
        status: "FAILED",
        errorCode,
        errorMessageSafe: "Could not reserve credits for this generation.",
        completedAt: new Date(),
      },
    });
    throw error;
  }

  await db.creatorGeneration.update({
    where: { id: generation.id },
    data: { status: "GENERATING" },
  });

  try {
    const result = await params.execute();
    const completed = await db.creatorGeneration.update({
      where: { id: generation.id },
      data: {
        status: "COMPLETED",
        outputAssetIds: result.outputAssetIds,
        output: result.output,
        providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
        creditsConsumed: params.creditCost,
        completedAt: new Date(),
      },
    });
    await commitCreatorCredits(ctx, {
      generationId: generation.id,
      reservedAmount: params.creditCost,
      actualAmount: params.creditCost,
    });
    await audit(ctx, {
      action: "creator.generation.complete",
      resourceType: "creator_generation",
      resourceId: generation.id,
      after: { generationType: params.generationType, creditsConsumed: params.creditCost },
    });
    return completed;
  } catch (error) {
    // Never persist raw provider error text (§4: sanitize before surfacing) —
    // full detail goes to server logs only, never to a client-reachable field.
    console.error("creator generation failed", {
      generationId: generation.id,
      orgId: ctx.orgId,
      error,
    });
    await db.creatorGeneration.update({
      where: { id: generation.id },
      data: {
        status: "FAILED",
        errorCode: "provider_error",
        errorMessageSafe: "Generation failed. Please try again.",
        completedAt: new Date(),
      },
    });
    await releaseCreatorCredits(ctx, {
      generationId: generation.id,
      amount: params.creditCost,
      reason: "generation_failed",
    });
    await audit(ctx, {
      action: "creator.generation.failed",
      resourceType: "creator_generation",
      resourceId: generation.id,
      after: { errorCode: "provider_error" },
    });
    throw error;
  }
}

/** No real bytes are written for the mock provider (sizeBytes: 0, documented) — a real provider adapter must populate it. */
async function persistGeneratedAsset(
  ctx: TenantContext,
  creatorProfileId: string,
  storagePath: string,
  mimeType: string,
  assetType: string,
) {
  const db = tenantDb(ctx.orgId);
  const asset = await db.creatorReferenceAsset.create({
    data: {
      organizationId: ctx.orgId,
      creatorProfileId,
      storagePath,
      assetType,
      mimeType,
      sizeBytes: 0,
      source: "GENERATED",
      validationStatus: "APPROVED",
    },
  });
  return asset.id;
}

async function requireActiveProfileWithReferences(ctx: TenantContext, creatorProfileId: string) {
  const db = tenantDb(ctx.orgId);
  const profile = await db.creatorProfile.findFirstOrThrow({
    where: { id: creatorProfileId },
    include: { referenceAssets: { where: { validationStatus: "APPROVED" }, take: 10 } },
  });
  if (!profile.consentConfirmedAt) {
    throw new CreatorProfileError(
      "consent_required",
      "Creator consent must be confirmed before generating content.",
    );
  }
  if (profile.referenceAssets.length < MIN_REFERENCE_ASSETS) {
    throw new CreatorProfileError(
      "insufficient_reference_assets",
      `At least ${MIN_REFERENCE_ASSETS} approved reference images are required.`,
    );
  }
  return profile;
}

export async function requestCharacterImageGeneration(
  ctx: TenantContext,
  input: {
    creatorProfileId: string;
    templateId?: string;
    prompt: string;
    aspectRatio: AspectRatio;
    quality?: GenerationQuality;
  },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const profile = await requireActiveProfileWithReferences(ctx, input.creatorProfileId);
  const provider = getCreatorMediaProvider();
  const creditCost = getCreatorGenerationCreditCost("IMAGE", provider.name, "default", {
    quality: input.quality,
  });

  return runGeneration(ctx, {
    generationType: "IMAGE",
    provider: provider.name,
    model: "default",
    prompt: input.prompt,
    creatorProfileId: input.creatorProfileId,
    templateId: input.templateId,
    inputAssetIds: profile.referenceAssets.map((a) => a.id),
    creditCost,
    execute: async () => {
      const result = await provider.generateCharacterImage({
        prompt: input.prompt,
        referenceAssets: profile.referenceAssets.map((a) => ({
          storagePath: a.storagePath,
          source: a.source,
        })),
        aspectRatio: input.aspectRatio,
        quality: input.quality,
      });
      const assetId = await persistGeneratedAsset(
        ctx,
        input.creatorProfileId,
        result.outputStoragePath,
        result.mimeType,
        "generated_character_image",
      );
      return {
        outputAssetIds: [assetId],
        providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
      };
    },
  });
}

export async function requestImageFromCharacterGeneration(
  ctx: TenantContext,
  input: {
    creatorProfileId: string;
    templateId?: string;
    prompt: string;
    negativePrompt?: string;
    aspectRatio: AspectRatio;
    quality?: GenerationQuality;
  },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const profile = await requireActiveProfileWithReferences(ctx, input.creatorProfileId);
  const provider = getCreatorMediaProvider();
  const creditCost = getCreatorGenerationCreditCost("IMAGE", provider.name, "default", {
    quality: input.quality,
  });

  return runGeneration(ctx, {
    generationType: "IMAGE",
    provider: provider.name,
    model: "default",
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    creatorProfileId: input.creatorProfileId,
    templateId: input.templateId,
    inputAssetIds: profile.referenceAssets.map((a) => a.id),
    creditCost,
    execute: async () => {
      const result = await provider.generateImageFromCharacter({
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        referenceAssets: profile.referenceAssets.map((a) => ({
          storagePath: a.storagePath,
          source: a.source,
        })),
        aspectRatio: input.aspectRatio,
        quality: input.quality,
      });
      const assetId = await persistGeneratedAsset(
        ctx,
        input.creatorProfileId,
        result.outputStoragePath,
        result.mimeType,
        "generated_image",
      );
      return {
        outputAssetIds: [assetId],
        providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
      };
    },
  });
}

export async function requestVideoFromImageGeneration(
  ctx: TenantContext,
  input: {
    sourceAssetId: string;
    creatorProfileId?: string;
    motionPrompt?: string;
    durationSeconds?: number;
    aspectRatio: AspectRatio;
    quality?: GenerationQuality;
  },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const sourceAsset = await db.creatorReferenceAsset.findFirstOrThrow({
    where: { id: input.sourceAssetId },
  });
  const provider = getCreatorMediaProvider();
  const creditCost = getCreatorGenerationCreditCost("IMAGE_TO_VIDEO", provider.name, "default", {
    quality: input.quality,
    durationSeconds: input.durationSeconds,
  });
  const prompt = input.motionPrompt ?? "Animate this image with subtle natural motion.";

  return runGeneration(ctx, {
    generationType: "IMAGE_TO_VIDEO",
    provider: provider.name,
    model: "default",
    prompt,
    creatorProfileId: input.creatorProfileId ?? sourceAsset.creatorProfileId,
    inputAssetIds: [sourceAsset.id],
    creditCost,
    execute: async () => {
      const result = await provider.generateVideoFromImage({
        sourceAsset: { storagePath: sourceAsset.storagePath, source: sourceAsset.source },
        motionPrompt: input.motionPrompt,
        durationSeconds: input.durationSeconds,
        aspectRatio: input.aspectRatio,
        quality: input.quality,
      });
      const assetId = await persistGeneratedAsset(
        ctx,
        input.creatorProfileId ?? sourceAsset.creatorProfileId,
        result.outputStoragePath,
        result.mimeType,
        "generated_video",
      );
      return {
        outputAssetIds: [assetId],
        output: { durationSeconds: result.durationSeconds },
        providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
      };
    },
  });
}

export async function requestCaptionGeneration(
  ctx: TenantContext,
  input: {
    platform: string;
    language: CaptionLanguage;
    tone?: string;
    objective?: string;
    creatorProfileId?: string;
    campaignId?: string;
  },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const provider = getCreatorCaptionProvider();
  const creditCost = getCreatorGenerationCreditCost("CAPTION", provider.name, "default");

  const dna = await getBusinessDnaContext(ctx.orgId);
  const businessContext = buildBusinessDnaPromptBlock(dna) ?? undefined;
  const prompt = `Generate a ${input.platform} caption in ${input.language}${input.objective ? ` for: ${input.objective}` : ""}`;

  return runGeneration(ctx, {
    generationType: "CAPTION",
    provider: provider.name,
    model: "default",
    prompt,
    creatorProfileId: input.creatorProfileId,
    inputAssetIds: [],
    creditCost,
    execute: async () => {
      const result = await provider.generateCaption({
        platform: input.platform,
        language: input.language,
        tone: input.tone,
        objective: input.objective,
        businessContext,
      });
      return {
        outputAssetIds: [],
        output: {
          primary: result.primary,
          short: result.short,
          cta: result.cta,
          hashtags: result.hashtags,
        },
        providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
      };
    },
  });
}

export async function getGeneration(ctx: TenantContext, id: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return tenantDb(ctx.orgId).creatorGeneration.findFirstOrThrow({ where: { id } });
}

export async function listGenerations(
  ctx: TenantContext,
  filters: { creatorProfileId?: string; generationType?: CreatorGenerationType } = {},
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return tenantDb(ctx.orgId).creatorGeneration.findMany({
    where: {
      ...(filters.creatorProfileId ? { creatorProfileId: filters.creatorProfileId } : {}),
      ...(filters.generationType ? { generationType: filters.generationType } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
