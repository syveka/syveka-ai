import "server-only";

import type { CreatorGenerationType } from "@prisma/client";
import { unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { audit } from "./audit";
import {
  creatorGenerationCreditsSettled,
  commitCreatorCredits,
  releaseCreatorCredits,
} from "./creator-credits";
import {
  claimGenerationCompleted,
  claimGenerationFailed,
  persistGeneratedAsset,
} from "./creator-generations";
import { getFalJobStatus, fetchFalJobResult } from "@/server/integrations/fal";
import {
  persistFalOutput,
  interpretFalImageOutput,
  interpretFalVideoOutput,
  cleanupFalGeneratedOutput,
  type FalImageOutput,
  type FalVideoOutput,
} from "@/server/ai/creator/fal-provider";

/**
 * P0 crash-recovery reconciliation (docs/creator-studio.md §19 has the full
 * state machine). Bounded, idempotent, tenant-safe batch passes over stale
 * CreatorGeneration rows — never submits a new provider job, and every
 * state transition goes through the exact same claimGenerationCompleted /
 * claimGenerationFailed / commitCreatorCredits / releaseCreatorCredits a
 * live request uses, so a recovered generation can never diverge from a
 * live one's finalization logic.
 */

/**
 * fal.ai's own queue poll ceiling is 300s (runFalModel's MAX_POLL_ATTEMPTS *
 * POLL_INTERVAL_MS); the real observed Kling baseline was ~71s. A
 * GENERATING row is only "stale" once it has run well past even a
 * legitimately slow job's absolute ceiling, plus headroom for the
 * download/upload/DB work that still has to happen after the provider
 * responds — conservatively 2x the poll ceiling, so an in-flight request
 * still legitimately polling near the ceiling is never mistaken for
 * abandoned.
 */
const GENERATING_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * COMPLETED/FAILED rows are only checked for a stuck reservation within a
 * bounded recent window, not "all history forever" — the commit/release
 * failure this repairs is a rare edge case (see docs/creator-studio.md
 * §15), and an unbounded scan would grow forever. 48h is comfortably
 * longer than any plausible reconciliation-job outage; the lower bound
 * (createdAt < now - GENERATING_STALE_MS) keeps this from ever touching a
 * row whose live request might still be finishing its own bookkeeping.
 */
const SETTLEMENT_CHECK_WINDOW_MS = 48 * 60 * 60 * 1000;

const BATCH_SIZE = 25;

type RecoverableGeneration = {
  id: string;
  organizationId: string;
  createdById: string;
  generationType: CreatorGenerationType;
  creatorProfileId: string | null;
  creditsReserved: number;
  providerRequestId: string | null;
  status: string;
};

function systemCtx(generation: { organizationId: string; createdById: string }): TenantContext {
  // orgId/userId are the only fields any function on this path actually
  // reads (both traced: creator-credits.ts, creator-generations.ts, and
  // audit()'s Pick<TenantContext, "orgId" | "userId">); userId reuses the
  // original generation's real creator so ledger/audit attribution stays
  // honest and never references a fabricated system-user id.
  return {
    orgId: generation.organizationId,
    userId: generation.createdById,
    email: "",
    role: "OWNER",
    locale: "en",
  };
}

async function auditRecovery(
  ctx: TenantContext,
  action: string,
  generationId: string,
  after: Record<string, unknown>,
): Promise<void> {
  try {
    await audit(ctx, {
      action,
      resourceType: "creator_generation",
      resourceId: generationId,
      after,
      actorType: "system",
    });
  } catch (error) {
    console.error("creator generation recovery audit failed", {
      generationId,
      orgId: ctx.orgId,
      error,
    });
  }
}

type ProviderRequestRecord = {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  model: string;
  durationSeconds?: number;
};

/**
 * providerRequestId holds one of two shapes depending on when it's read:
 * a JSON-encoded ProviderRequestRecord (written early, before polling — see
 * persistProviderRequestIdentity in creator-generations.ts) while the
 * generation is still GENERATING, or a plain final output URL string once
 * COMPLETED. A non-JSON value here means either the generation already
 * completed (expected — not an error) or no identity was ever recorded.
 */
function parseProviderRequestRecord(raw: string | null): ProviderRequestRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).statusUrl === "string" &&
      typeof (parsed as Record<string, unknown>).responseUrl === "string"
    ) {
      return parsed as ProviderRequestRecord;
    }
  } catch {
    // Not JSON — a plain output URL, not a mid-flight record.
  }
  return null;
}

export type ReconcileGenerationsResult = {
  staleGeneratingChecked: number;
  resumedRunning: number;
  recoveredCompleted: number;
  recoveredFailed: number;
  manualReviewFlagged: number;
  settlementChecked: number;
  settlementRepaired: number;
  nextGeneratingCursor: string | null;
  nextSettlementCursor: string | null;
};

/** One bounded reconciliation pass across every organization. Never submits a new provider job. */
export async function reconcileCreatorGenerations(params: {
  generatingCursor?: string;
  settlementCursor?: string;
}): Promise<ReconcileGenerationsResult> {
  const now = Date.now();
  const staleGeneratingBefore = new Date(now - GENERATING_STALE_MS);
  const settlementWindowStart = new Date(now - SETTLEMENT_CHECK_WINDOW_MS);

  const result: ReconcileGenerationsResult = {
    staleGeneratingChecked: 0,
    resumedRunning: 0,
    recoveredCompleted: 0,
    recoveredFailed: 0,
    manualReviewFlagged: 0,
    settlementChecked: 0,
    settlementRepaired: 0,
    nextGeneratingCursor: null,
    nextSettlementCursor: null,
  };

  const staleGenerating = await unscopedPrisma.creatorGeneration.findMany({
    where: {
      status: "GENERATING",
      createdAt: { lt: staleGeneratingBefore },
      ...(params.generatingCursor ? { id: { gt: params.generatingCursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
  result.staleGeneratingChecked = staleGenerating.length;
  result.nextGeneratingCursor =
    staleGenerating.length === BATCH_SIZE
      ? (staleGenerating[staleGenerating.length - 1]?.id ?? null)
      : null;

  for (const generation of staleGenerating) {
    await reconcileStaleGenerating(generation, result);
  }

  const settlementCandidates = await unscopedPrisma.creatorGeneration.findMany({
    where: {
      status: { in: ["COMPLETED", "FAILED"] },
      creditsReserved: { gt: 0 },
      createdAt: { gte: settlementWindowStart, lt: staleGeneratingBefore },
      ...(params.settlementCursor ? { id: { gt: params.settlementCursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
  result.settlementChecked = settlementCandidates.length;
  result.nextSettlementCursor =
    settlementCandidates.length === BATCH_SIZE
      ? (settlementCandidates[settlementCandidates.length - 1]?.id ?? null)
      : null;

  for (const generation of settlementCandidates) {
    await reconcileSettlement(generation, result);
  }

  return result;
}

async function reconcileStaleGenerating(
  generation: RecoverableGeneration,
  result: ReconcileGenerationsResult,
): Promise<void> {
  const ctx = systemCtx(generation);
  const record = parseProviderRequestRecord(generation.providerRequestId);

  if (!record) {
    // CASE A: stale GENERATING, no durable provider identity. The crash
    // window between a provider accepting a job and Syveka persisting its
    // identity is real, however narrow — providerRequestId === null does
    // NOT prove no paid job exists. Never auto-release; escalate instead,
    // idempotently (skip if already flagged by an earlier pass).
    const alreadyFlagged = await unscopedPrisma.auditLog.findFirst({
      where: {
        resourceId: generation.id,
        action: "creator.generation.recovery_manual_review_required",
      },
    });
    if (!alreadyFlagged) {
      console.warn(
        "stale GENERATING generation with no provider request identity — manual review required",
        { generationId: generation.id, orgId: generation.organizationId },
      );
      await auditRecovery(
        ctx,
        "creator.generation.recovery_manual_review_required",
        generation.id,
        {
          reason: "stale_generating_no_provider_request_id",
        },
      );
      result.manualReviewFlagged += 1;
    }
    return;
  }

  let status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "UNKNOWN";
  try {
    status = await getFalJobStatus(record.statusUrl);
  } catch (error) {
    console.error("stale GENERATING generation: provider status check failed", {
      generationId: generation.id,
      orgId: generation.organizationId,
      error,
    });
    await auditRecovery(ctx, "creator.generation.recovery_failed", generation.id, {
      reason: "provider_status_check_threw",
    });
    result.manualReviewFlagged += 1;
    return; // never release blindly — the provider may still have a live job
  }

  if (status === "QUEUED" || status === "IN_PROGRESS") {
    result.resumedRunning += 1; // still legitimately running — leave it for the next pass
    return;
  }

  if (status === "UNKNOWN") {
    await auditRecovery(ctx, "creator.generation.recovery_manual_review_required", generation.id, {
      reason: "provider_status_unknown",
    });
    result.manualReviewFlagged += 1;
    return;
  }

  if (status === "FAILED") {
    const claim = await claimGenerationFailed(
      ctx,
      generation.id,
      generation.creditsReserved,
      "provider_error",
      "Generation failed. Please try again.",
    );
    if (claim.claimed) {
      await auditRecovery(ctx, "creator.generation.recovered", generation.id, {
        outcome: "failed_and_released",
      });
      result.recoveredFailed += 1;
    }
    return;
  }

  // status === "COMPLETED" — retrieve the EXISTING output, never resubmit.
  try {
    await finalizeRecoveredCompletion(ctx, generation, record);
    result.recoveredCompleted += 1;
    await auditRecovery(ctx, "creator.generation.recovered", generation.id, {
      outcome: "completed",
    });
  } catch (error) {
    // The provider really did complete the job — releasing credits here
    // would be financially wrong even though Syveka failed to persist the
    // output. Leave the row GENERATING so the next pass retries
    // finalization (e.g. a transient download/Storage failure).
    console.error(
      "stale GENERATING generation: provider reports COMPLETED but finalization failed",
      { generationId: generation.id, orgId: generation.organizationId, error },
    );
    await auditRecovery(ctx, "creator.generation.recovery_failed", generation.id, {
      reason: "finalize_from_recovered_output_failed",
    });
    result.manualReviewFlagged += 1;
  }
}

/**
 * Same compensating-cleanup contract as
 * creator-generations.ts's persistGeneratedAssetWithCleanup — reused here
 * directly against fal-provider.ts's cleanup function rather than through
 * the CreatorMediaProvider interface, since this recovery path already
 * talks to fal.ai's queue API directly (getFalJobStatus/fetchFalJobResult)
 * without going through that abstraction.
 */
async function persistRecoveredAssetWithCleanup(
  ctx: TenantContext,
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
      await cleanupFalGeneratedOutput(storagePath);
    } catch (cleanupError) {
      console.error(
        "failed to clean up an orphaned generated Storage object after recovered-asset persistence failed",
        { storagePath, orgId: ctx.orgId, cleanupError },
      );
    }
    throw dbError;
  }
}

async function finalizeRecoveredCompletion(
  ctx: TenantContext,
  generation: RecoverableGeneration,
  record: ProviderRequestRecord,
): Promise<void> {
  const raw = await fetchFalJobResult<unknown>(record.responseUrl);

  if (generation.generationType === "IMAGE") {
    const { url, contentType, extension } = interpretFalImageOutput(raw as FalImageOutput);
    const { storagePath, mimeType, sizeBytes } = await persistFalOutput(
      url,
      contentType,
      extension,
    );
    if (!generation.creatorProfileId) {
      throw new Error(
        "recovered IMAGE generation has no creatorProfileId to attach the output asset to",
      );
    }
    const assetId = await persistRecoveredAssetWithCleanup(
      ctx,
      generation.creatorProfileId,
      storagePath,
      mimeType,
      sizeBytes,
      "generated_image",
    );
    await claimGenerationCompleted(
      ctx,
      generation.id,
      generation.generationType,
      generation.creditsReserved,
      {
        outputAssetIds: [assetId],
        providerRequestId: url,
        latencyMs: 0, // not knowable across a process boundary — explicit zero, never a fabricated guess
      },
    );
    return;
  }

  if (generation.generationType === "IMAGE_TO_VIDEO") {
    const { url, contentType, extension } = interpretFalVideoOutput(raw as FalVideoOutput);
    const { storagePath, mimeType, sizeBytes } = await persistFalOutput(
      url,
      contentType,
      extension,
    );
    if (!generation.creatorProfileId) {
      throw new Error(
        "recovered IMAGE_TO_VIDEO generation has no creatorProfileId to attach the output asset to",
      );
    }
    const assetId = await persistRecoveredAssetWithCleanup(
      ctx,
      generation.creatorProfileId,
      storagePath,
      mimeType,
      sizeBytes,
      "generated_video",
    );
    await claimGenerationCompleted(
      ctx,
      generation.id,
      generation.generationType,
      generation.creditsReserved,
      {
        outputAssetIds: [assetId],
        output: { durationSeconds: record.durationSeconds ?? 0 },
        providerRequestId: url,
        latencyMs: 0,
      },
    );
    return;
  }

  throw new Error(
    `recovery finalization not supported for generation type ${generation.generationType}`,
  );
}

async function reconcileSettlement(
  generation: RecoverableGeneration,
  result: ReconcileGenerationsResult,
): Promise<void> {
  const settled = await creatorGenerationCreditsSettled(generation.id);
  if (settled) return; // nothing to repair

  const ctx = systemCtx(generation);

  if (generation.status === "COMPLETED") {
    try {
      const { applied } = await commitCreatorCredits(ctx, {
        generationId: generation.id,
        reservedAmount: generation.creditsReserved,
        actualAmount: generation.creditsReserved,
      });
      if (applied) {
        result.settlementRepaired += 1;
        await auditRecovery(ctx, "creator.generation.recovered", generation.id, {
          outcome: "commit_repaired",
        });
      }
    } catch (error) {
      console.error("COMPLETED generation with stuck RESERVED credits: repair commit failed", {
        generationId: generation.id,
        orgId: generation.organizationId,
        error,
      });
      await auditRecovery(ctx, "creator.generation.recovery_failed", generation.id, {
        reason: "commit_repair_failed",
      });
    }
    return;
  }

  if (generation.status === "FAILED") {
    try {
      const { applied } = await releaseCreatorCredits(ctx, {
        generationId: generation.id,
        amount: generation.creditsReserved,
        reason: "reconciliation_repair",
      });
      if (applied) {
        result.settlementRepaired += 1;
        await auditRecovery(ctx, "creator.generation.recovered", generation.id, {
          outcome: "release_repaired",
        });
      }
    } catch (error) {
      console.error("FAILED generation with stuck RESERVED credits: repair release failed", {
        generationId: generation.id,
        orgId: generation.organizationId,
        error,
      });
      await auditRecovery(ctx, "creator.generation.recovery_failed", generation.id, {
        reason: "release_repair_failed",
      });
    }
  }
}
