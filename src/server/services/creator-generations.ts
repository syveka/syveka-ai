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
import type {
  AspectRatio,
  GenerationQuality,
  CaptionLanguage,
  ProviderSubmissionInfo,
} from "@/server/ai/creator";
import { getBusinessDnaContext, buildBusinessDnaPromptBlock } from "@/server/business-dna/context";
import { MIN_REFERENCE_ASSETS } from "@/lib/validators/creator-studio";

type GenerationExecution = {
  outputAssetIds: string[];
  output?: Prisma.InputJsonValue;
  providerRequestId: string;
  latencyMs: number;
};

/**
 * Durably records a real provider job's identity as early as possible —
 * immediately after fal.ai (or any future real provider) accepts the job,
 * before any polling/waiting begins (P0 crash-recovery hardening). Encoded
 * as JSON into the existing nullable `providerRequestId` column rather than
 * a new one: that column already means "how to identify this generation's
 * provider-side work," and it gets unconditionally overwritten with the
 * real final output identifier once the generation completes, so an early
 * JSON-encoded value here is never left stale.
 *
 * The conditional `where: { providerRequestId: null }` guards against
 * silently overwriting a different, already-recorded identity — this
 * should only ever be called once per generation, but guards against it
 * being called twice regardless (count !== 1 throws rather than clobbers).
 */
export async function persistProviderRequestIdentity(
  ctx: TenantContext,
  generationId: string,
  info: ProviderSubmissionInfo,
): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const claim = await db.creatorGeneration.updateMany({
    where: { id: generationId, providerRequestId: null },
    data: { providerRequestId: JSON.stringify(info) },
  });
  if (claim.count !== 1) {
    throw new Error(
      "Failed to durably record the provider job's identity before polling — refusing to continue.",
    );
  }
}

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
    execute: (generationId: string) => Promise<GenerationExecution>;
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
    const result = await params.execute(generation.id);
    const claim = await claimGenerationCompleted(
      ctx,
      generation.id,
      params.generationType,
      params.creditCost,
      result,
    );
    if (!claim.claimed) {
      console.warn("creator generation already finalized elsewhere; skipping duplicate commit", {
        generationId: generation.id,
        orgId: ctx.orgId,
      });
    }
    return db.creatorGeneration.findUniqueOrThrow({ where: { id: generation.id } });
  } catch (error) {
    // Never persist raw provider error text (§4: sanitize before surfacing) —
    // full detail goes to server logs only, never to a client-reachable field.
    console.error("creator generation failed", {
      generationId: generation.id,
      orgId: ctx.orgId,
      error,
    });
    const claim = await claimGenerationFailed(
      ctx,
      generation.id,
      params.creditCost,
      "provider_error",
      "Generation failed. Please try again.",
    );
    if (!claim.claimed) {
      console.warn("creator generation already finalized elsewhere; skipping duplicate release", {
        generationId: generation.id,
        orgId: ctx.orgId,
      });
    }
    throw error;
  }
}

/**
 * Atomically claims a GENERATING row as COMPLETED and runs its bookkeeping.
 * Exported so the crash-recovery reconciler can finalize a job it recovers
 * through the exact same claim + finalize path a live request uses — never
 * a separate, potentially-divergent implementation. Returns `{ claimed:
 * false }` (a safe no-op) if the row was no longer GENERATING when this ran
 * (already finalized by another path, or the reconciler and a live request
 * racing) — same atomic-UPDATE pattern publishCreatorPost's `claim` uses in
 * creator-publishing.ts.
 */
export async function claimGenerationCompleted(
  ctx: TenantContext,
  generationId: string,
  generationType: CreatorGenerationType,
  creditCost: number,
  result: GenerationExecution,
): Promise<{ claimed: boolean }> {
  const db = tenantDb(ctx.orgId);
  const claim = await db.creatorGeneration.updateMany({
    where: { id: generationId, status: "GENERATING" },
    data: {
      status: "COMPLETED",
      outputAssetIds: result.outputAssetIds,
      output: result.output,
      providerRequestId: result.providerRequestId,
      latencyMs: result.latencyMs,
      creditsConsumed: creditCost,
      completedAt: new Date(),
    },
  });
  if (claim.count !== 1) return { claimed: false };
  // COMPLETED is now claimed and terminal — the real provider output,
  // asset, and Storage object all genuinely exist. Everything past this
  // point is bookkeeping only (credit commit + audit), isolated in its own
  // try/catch: a failure here must never be reported as a generation
  // failure, must never attempt a FAILED transition on an already-COMPLETED
  // row, and must never release credits for a generation that has already
  // succeeded.
  await finalizeCompletedGenerationBookkeeping(ctx, generationId, creditCost, generationType);
  return { claimed: true };
}

/**
 * Atomically claims a GENERATING row as FAILED and runs its bookkeeping.
 * Same reuse rationale as claimGenerationCompleted above — the
 * reconciler's FAILED path must go through this, never a reimplementation.
 */
export async function claimGenerationFailed(
  ctx: TenantContext,
  generationId: string,
  creditCost: number,
  errorCode: string,
  errorMessageSafe: string,
): Promise<{ claimed: boolean }> {
  const db = tenantDb(ctx.orgId);
  const claim = await db.creatorGeneration.updateMany({
    where: { id: generationId, status: "GENERATING" },
    data: { status: "FAILED", errorCode, errorMessageSafe, completedAt: new Date() },
  });
  if (claim.count !== 1) return { claimed: false };
  await finalizeFailedGenerationBookkeeping(ctx, generationId, creditCost);
  return { claimed: true };
}

/**
 * Runs only after a generation has already been successfully claimed
 * COMPLETED — the real provider output, asset, and Storage object all
 * genuinely exist at this point. Both steps below are pure bookkeeping
 * (crediting and audit logging); a failure in either must never be
 * reported as a generation failure, must never attempt to move an
 * already-COMPLETED row to FAILED, and must never release credits for a
 * generation that has already succeeded — so each has its own isolated
 * try/catch that only logs, never rethrows.
 *
 * commitCreatorCredits is now transactionally idempotent (a unique
 * (generationId, type) index on CreatorCreditTransaction makes a second
 * COMMIT for the same generation a safe no-op rather than a double-apply —
 * see creator-credits.ts), so a caller (e.g. a reconciliation repair) may
 * call this again for the same generation without risk.
 */
async function finalizeCompletedGenerationBookkeeping(
  ctx: TenantContext,
  generationId: string,
  creditCost: number,
  generationType: CreatorGenerationType,
): Promise<void> {
  try {
    const { applied } = await commitCreatorCredits(ctx, {
      generationId,
      reservedAmount: creditCost,
      actualAmount: creditCost,
    });
    if (!applied) return; // already committed (or released) by another path — nothing more to do
  } catch (error) {
    console.error(
      "creator generation completed but credit commit failed; credits remain reserved",
      { generationId, orgId: ctx.orgId, error },
    );
    return;
  }

  try {
    await audit(ctx, {
      action: "creator.generation.complete",
      resourceType: "creator_generation",
      resourceId: generationId,
      after: { generationType, creditsConsumed: creditCost },
    });
  } catch (error) {
    console.error("creator generation completed and committed but audit logging failed", {
      generationId,
      orgId: ctx.orgId,
      error,
    });
  }
}

/**
 * Mirrors finalizeCompletedGenerationBookkeeping for the FAILED path — a
 * releaseCreatorCredits or audit failure here must never propagate as an
 * unhandled exception (which would otherwise mask the real failure reason
 * and could leave the generation FAILED with credits still RESERVED, with
 * no record of why).
 */
async function finalizeFailedGenerationBookkeeping(
  ctx: TenantContext,
  generationId: string,
  creditCost: number,
): Promise<void> {
  try {
    const { applied } = await releaseCreatorCredits(ctx, {
      generationId,
      amount: creditCost,
      reason: "generation_failed",
    });
    if (!applied) return; // already released (or committed) by another path
  } catch (error) {
    console.error("creator generation failed but credit release failed; credits remain reserved", {
      generationId,
      orgId: ctx.orgId,
      error,
    });
    return;
  }

  try {
    await audit(ctx, {
      action: "creator.generation.failed",
      resourceType: "creator_generation",
      resourceId: generationId,
      after: { errorCode: "provider_error" },
    });
  } catch (error) {
    console.error("creator generation failed and released but audit logging failed", {
      generationId,
      orgId: ctx.orgId,
      error,
    });
  }
}

/** Exported so the crash-recovery reconciler can persist a recovered job's output asset through the exact same path a live request uses. */
export async function persistGeneratedAsset(
  ctx: TenantContext,
  creatorProfileId: string,
  storagePath: string,
  mimeType: string,
  sizeBytes: number,
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
      sizeBytes,
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
    execute: async (generationId) => {
      const result = await provider.generateCharacterImage({
        prompt: input.prompt,
        referenceAssets: profile.referenceAssets.map((a) => ({
          storagePath: a.storagePath,
          source: a.source,
        })),
        aspectRatio: input.aspectRatio,
        quality: input.quality,
        onProviderSubmitted: (info) => persistProviderRequestIdentity(ctx, generationId, info),
      });
      const assetId = await persistGeneratedAsset(
        ctx,
        input.creatorProfileId,
        result.outputStoragePath,
        result.mimeType,
        result.sizeBytes,
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
    execute: async (generationId) => {
      const result = await provider.generateImageFromCharacter({
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        referenceAssets: profile.referenceAssets.map((a) => ({
          storagePath: a.storagePath,
          source: a.source,
        })),
        aspectRatio: input.aspectRatio,
        quality: input.quality,
        onProviderSubmitted: (info) => persistProviderRequestIdentity(ctx, generationId, info),
      });
      const assetId = await persistGeneratedAsset(
        ctx,
        input.creatorProfileId,
        result.outputStoragePath,
        result.mimeType,
        result.sizeBytes,
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
    execute: async (generationId) => {
      const result = await provider.generateVideoFromImage({
        sourceAsset: { storagePath: sourceAsset.storagePath, source: sourceAsset.source },
        motionPrompt: input.motionPrompt,
        durationSeconds: input.durationSeconds,
        aspectRatio: input.aspectRatio,
        quality: input.quality,
        onProviderSubmitted: (info) => persistProviderRequestIdentity(ctx, generationId, info),
      });
      const assetId = await persistGeneratedAsset(
        ctx,
        input.creatorProfileId ?? sourceAsset.creatorProfileId,
        result.outputStoragePath,
        result.mimeType,
        result.sizeBytes,
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
