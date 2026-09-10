import "server-only";

import { Prisma, type CreatorGenerationType } from "@prisma/client";
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
  CreatorMediaProvider,
} from "@/server/ai/creator";
import { getBusinessDnaContext, buildBusinessDnaPromptBlock } from "@/server/business-dna/context";
import { MIN_REFERENCE_ASSETS } from "@/lib/validators/creator-studio";
import { IdempotencyConflictError, computeRequestFingerprint } from "./creator-studio-idempotency";

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
 * Looks up an existing logical request for an idempotency key, scoped to
 * (organizationId, generationType) — the exact same scope the DB unique
 * constraint enforces, so this always finds the row the constraint would
 * conflict with.
 */
async function findExistingIdempotentGeneration(
  db: ReturnType<typeof tenantDb>,
  generationType: CreatorGenerationType,
  idempotencyKey: string,
) {
  return db.creatorGeneration.findFirst({ where: { generationType, idempotencyKey } });
}

/** Same key, different normalized request → conflict, never a silent reuse. */
function assertFingerprintMatches(
  existing: { requestFingerprint: string | null },
  requestFingerprint: string,
): void {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyConflictError();
  }
}

/**
 * Shared reserve → execute → commit/release orchestration (Phase 2 + 13),
 * now also the sole place request-level idempotency (P1) is enforced.
 * Every capability below goes through this so credit accounting, audit
 * logging, error handling, and idempotency semantics never drift between
 * generation types.
 *
 * Idempotency design: the `creatorGeneration.create()` insert below is
 * itself the concurrency authority (never a separate check-then-create) —
 * a unique (organizationId, generationType, idempotencyKey) DB constraint
 * means two concurrent requests for the same key can never both create a
 * row; the loser's insert fails with Prisma's P2002, and it fetches and
 * returns the winner's row instead of creating (and reserving credits
 * for) its own. No key sent → idempotencyKey is null → the constraint
 * never applies (Postgres treats every NULL as distinct) → current
 * behavior is preserved exactly.
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
    idempotencyKey?: string;
    /** Only meaningful (and only ever compared) when idempotencyKey is set. */
    requestFingerprint?: string;
    execute: (generationId: string) => Promise<GenerationExecution>;
  },
) {
  const db = tenantDb(ctx.orgId);

  if (params.idempotencyKey) {
    const existing = await findExistingIdempotentGeneration(
      db,
      params.generationType,
      params.idempotencyKey,
    );
    if (existing) {
      assertFingerprintMatches(existing, params.requestFingerprint ?? "");
      return { generation: existing, reused: true };
    }
  }

  let generation;
  try {
    generation = await db.creatorGeneration.create({
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
        idempotencyKey: params.idempotencyKey,
        requestFingerprint: params.idempotencyKey ? params.requestFingerprint : undefined,
      },
    });
  } catch (error) {
    if (
      params.idempotencyKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Lost the race for this idempotency key — fetch and return the
      // winner's row instead of ours. Zero credits reserved on this path.
      const winner = await findExistingIdempotentGeneration(
        db,
        params.generationType,
        params.idempotencyKey,
      );
      if (!winner) throw error; // the constraint just fired, so a row must exist — defensive only
      assertFingerprintMatches(winner, params.requestFingerprint ?? "");
      return { generation: winner, reused: true };
    }
    throw error;
  }

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
    const final = await db.creatorGeneration.findUniqueOrThrow({ where: { id: generation.id } });
    return { generation: final, reused: false };
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

/**
 * Wraps persistGeneratedAsset with compensating Storage cleanup (P1
 * orphan-cleanup hardening): by the time this runs, the provider has
 * already uploaded real bytes to `storagePath` — if the DB row create then
 * fails, that upload is otherwise permanently orphaned (nothing else ever
 * points at it, and it will never appear in any listing a user sees). On
 * failure, this attempts exactly one best-effort delete of that exact path
 * via the SAME provider that just uploaded it (never an arbitrary
 * bucket/path — provider.cleanupGeneratedOutput is always scoped to its
 * own fixed generated-output bucket).
 *
 * The original DB error is always what propagates to the caller,
 * regardless of whether cleanup succeeds — a cleanup failure is logged
 * separately (never thrown, never masks the real failure, never retried).
 */
export async function persistGeneratedAssetWithCleanup(
  ctx: TenantContext,
  provider: CreatorMediaProvider,
  creatorProfileId: string,
  storagePath: string,
  mimeType: string,
  sizeBytes: number,
  assetType: string,
): Promise<string> {
  try {
    return await persistGeneratedAsset(
      ctx,
      creatorProfileId,
      storagePath,
      mimeType,
      sizeBytes,
      assetType,
    );
  } catch (dbError) {
    try {
      await provider.cleanupGeneratedOutput(storagePath);
    } catch (cleanupError) {
      console.error(
        "failed to clean up an orphaned generated Storage object after DB asset persistence failed",
        { storagePath, orgId: ctx.orgId, provider: provider.name, cleanupError },
      );
    }
    throw dbError;
  }
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
    idempotencyKey?: string;
  },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const profile = await requireActiveProfileWithReferences(ctx, input.creatorProfileId);
  const provider = getCreatorMediaProvider();
  const creditCost = getCreatorGenerationCreditCost("IMAGE", provider.name, "default", {
    quality: input.quality,
  });
  const requestFingerprint = computeRequestFingerprint({
    op: "character-image",
    creatorProfileId: input.creatorProfileId,
    templateId: input.templateId,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
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
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
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
      const assetId = await persistGeneratedAssetWithCleanup(
        ctx,
        provider,
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
    idempotencyKey?: string;
  },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const profile = await requireActiveProfileWithReferences(ctx, input.creatorProfileId);
  const provider = getCreatorMediaProvider();
  const creditCost = getCreatorGenerationCreditCost("IMAGE", provider.name, "default", {
    quality: input.quality,
  });
  const requestFingerprint = computeRequestFingerprint({
    op: "image-from-character",
    creatorProfileId: input.creatorProfileId,
    templateId: input.templateId,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    aspectRatio: input.aspectRatio,
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
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
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
      const assetId = await persistGeneratedAssetWithCleanup(
        ctx,
        provider,
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
    idempotencyKey?: string;
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
  const requestFingerprint = computeRequestFingerprint({
    op: "video-from-image",
    sourceAssetId: input.sourceAssetId,
    creatorProfileId: input.creatorProfileId ?? sourceAsset.creatorProfileId,
    motionPrompt: input.motionPrompt,
    durationSeconds: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    quality: input.quality,
  });

  return runGeneration(ctx, {
    generationType: "IMAGE_TO_VIDEO",
    provider: provider.name,
    model: "default",
    prompt,
    creatorProfileId: input.creatorProfileId ?? sourceAsset.creatorProfileId,
    inputAssetIds: [sourceAsset.id],
    creditCost,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    execute: async (generationId) => {
      const result = await provider.generateVideoFromImage({
        sourceAsset: { storagePath: sourceAsset.storagePath, source: sourceAsset.source },
        motionPrompt: input.motionPrompt,
        durationSeconds: input.durationSeconds,
        aspectRatio: input.aspectRatio,
        quality: input.quality,
        onProviderSubmitted: (info) => persistProviderRequestIdentity(ctx, generationId, info),
      });
      const assetId = await persistGeneratedAssetWithCleanup(
        ctx,
        provider,
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
