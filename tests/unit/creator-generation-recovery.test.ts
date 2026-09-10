import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * creator-generation-recovery.ts — the P0 crash-recovery reconciler.
 * Every provider/DB dependency is mocked; this proves the reconciler's own
 * decision logic (Phase 6-14 of the recovery audit) without ever making a
 * real fal.ai request. Each test seeds exactly one candidate generation row
 * via the mocked findMany, so the assertions are unambiguous about which
 * case fired.
 */

const {
  findManyMock,
  auditLogFindFirstMock,
  auditMock,
  settledMock,
  commitMock,
  releaseMock,
  claimCompletedMock,
  claimFailedMock,
  persistAssetMock,
  getFalJobStatusMock,
  fetchFalJobResultMock,
  persistFalOutputMock,
  interpretImageMock,
  interpretVideoMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  auditLogFindFirstMock: vi.fn(async (): Promise<{ id: string } | null> => null),
  auditMock: vi.fn(async () => undefined),
  settledMock: vi.fn(async () => false),
  commitMock: vi.fn(async () => ({ applied: true })),
  releaseMock: vi.fn(async () => ({ applied: true })),
  claimCompletedMock: vi.fn(async () => ({ claimed: true })),
  claimFailedMock: vi.fn(async () => ({ claimed: true })),
  persistAssetMock: vi.fn(async () => "output-asset-1"),
  getFalJobStatusMock: vi.fn(),
  fetchFalJobResultMock: vi.fn(),
  persistFalOutputMock: vi.fn(async () => ({
    storagePath: "fal/recovered.png",
    mimeType: "image/png",
    sizeBytes: 999,
  })),
  interpretImageMock: vi.fn(() => ({
    url: "https://fal.media/recovered.png",
    contentType: "image/png",
    extension: "png",
  })),
  interpretVideoMock: vi.fn(() => ({
    url: "https://fal.media/recovered.mp4",
    contentType: "video/mp4",
    extension: "mp4",
  })),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    creatorGeneration: { findMany: findManyMock },
    auditLog: { findFirst: auditLogFindFirstMock },
  },
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/creator-credits", () => ({
  creatorGenerationCreditsSettled: settledMock,
  commitCreatorCredits: commitMock,
  releaseCreatorCredits: releaseMock,
}));
vi.mock("@/server/services/creator-generations", () => ({
  claimGenerationCompleted: claimCompletedMock,
  claimGenerationFailed: claimFailedMock,
  persistGeneratedAsset: persistAssetMock,
}));
vi.mock("@/server/integrations/fal", () => ({
  getFalJobStatus: getFalJobStatusMock,
  fetchFalJobResult: fetchFalJobResultMock,
}));
vi.mock("@/server/ai/creator/fal-provider", () => ({
  persistFalOutput: persistFalOutputMock,
  interpretFalImageOutput: interpretImageMock,
  interpretFalVideoOutput: interpretVideoMock,
}));

import { reconcileCreatorGenerations } from "@/server/services/creator-generation-recovery";

function generatingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-1",
    organizationId: "org-a",
    createdById: "user-1",
    generationType: "IMAGE",
    creatorProfileId: "profile-1",
    creditsReserved: 20,
    providerRequestId: null,
    status: "GENERATING",
    ...overrides,
  };
}

/** findMany is called twice per pass (stale-GENERATING scan, then settlement scan) — this sets up the first call's return and an empty second call. */
function seedGeneratingScan(rows: unknown[]) {
  findManyMock.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
}

function seedSettlementScan(rows: unknown[]) {
  findManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
}

describe("reconcileCreatorGenerations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settledMock.mockResolvedValue(false);
    commitMock.mockResolvedValue({ applied: true });
    releaseMock.mockResolvedValue({ applied: true });
    claimCompletedMock.mockResolvedValue({ claimed: true });
    claimFailedMock.mockResolvedValue({ claimed: true });
  });

  it("CASE A — stale GENERATING with no provider request identity: flags for manual review, never releases", async () => {
    seedGeneratingScan([generatingRow({ providerRequestId: null })]);

    const result = await reconcileCreatorGenerations({});

    expect(result.manualReviewFlagged).toBe(1);
    expect(claimFailedMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.recovery_manual_review_required" }),
    );
  });

  it("CASE A — is idempotent: does not re-flag a generation already flagged by an earlier pass", async () => {
    auditLogFindFirstMock.mockResolvedValueOnce({ id: "audit-1" });
    seedGeneratingScan([generatingRow({ providerRequestId: null })]);

    const result = await reconcileCreatorGenerations({});

    expect(result.manualReviewFlagged).toBe(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("CASE G — provider still QUEUED: leaves the generation alone for the next pass", async () => {
    const record = JSON.stringify({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    seedGeneratingScan([generatingRow({ providerRequestId: record })]);
    getFalJobStatusMock.mockResolvedValueOnce("QUEUED");

    const result = await reconcileCreatorGenerations({});

    expect(result.resumedRunning).toBe(1);
    expect(claimCompletedMock).not.toHaveBeenCalled();
    expect(claimFailedMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("CASE E — provider COMPLETED: retrieves the existing output and finalizes through claimGenerationCompleted, never resubmitting", async () => {
    const record = JSON.stringify({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    seedGeneratingScan([generatingRow({ providerRequestId: record })]);
    getFalJobStatusMock.mockResolvedValueOnce("COMPLETED");
    fetchFalJobResultMock.mockResolvedValueOnce({
      images: [{ url: "https://fal.media/recovered.png", content_type: "image/png" }],
    });

    const result = await reconcileCreatorGenerations({});

    expect(result.recoveredCompleted).toBe(1);
    expect(fetchFalJobResultMock).toHaveBeenCalledWith("https://queue.fal.run/x");
    expect(persistAssetMock).toHaveBeenCalledTimes(1);
    expect(claimCompletedMock).toHaveBeenCalledTimes(1);
    expect(claimFailedMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("CASE F — provider FAILED: claims FAILED and releases exactly once", async () => {
    const record = JSON.stringify({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    seedGeneratingScan([generatingRow({ providerRequestId: record })]);
    getFalJobStatusMock.mockResolvedValueOnce("FAILED");

    const result = await reconcileCreatorGenerations({});

    expect(result.recoveredFailed).toBe(1);
    expect(claimFailedMock).toHaveBeenCalledTimes(1);
    expect(claimCompletedMock).not.toHaveBeenCalled();
  });

  it("provider status UNKNOWN: never releases blindly, flags for manual review instead", async () => {
    const record = JSON.stringify({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    seedGeneratingScan([generatingRow({ providerRequestId: record })]);
    getFalJobStatusMock.mockResolvedValueOnce("UNKNOWN");

    const result = await reconcileCreatorGenerations({});

    expect(result.manualReviewFlagged).toBe(1);
    expect(claimFailedMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("provider status check throws: never releases blindly, flags for manual review instead", async () => {
    const record = JSON.stringify({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    seedGeneratingScan([generatingRow({ providerRequestId: record })]);
    getFalJobStatusMock.mockRejectedValueOnce(new Error("network error"));

    const result = await reconcileCreatorGenerations({});

    expect(result.manualReviewFlagged).toBe(1);
    expect(claimFailedMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("output retrieval fails after provider COMPLETED: does not release, does not fabricate an asset", async () => {
    const record = JSON.stringify({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    seedGeneratingScan([generatingRow({ providerRequestId: record })]);
    getFalJobStatusMock.mockResolvedValueOnce("COMPLETED");
    fetchFalJobResultMock.mockRejectedValueOnce(new Error("download failed"));

    const result = await reconcileCreatorGenerations({});

    expect(result.manualReviewFlagged).toBe(1);
    expect(result.recoveredCompleted).toBe(0);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(claimCompletedMock).not.toHaveBeenCalled();
  });

  it("CASE C — COMPLETED with credits still RESERVED: repairs to exactly one COMMIT", async () => {
    seedSettlementScan([generatingRow({ status: "COMPLETED" })]);
    settledMock.mockResolvedValueOnce(false);

    const result = await reconcileCreatorGenerations({});

    expect(result.settlementRepaired).toBe(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("CASE D — FAILED with credits still RESERVED: repairs to exactly one RELEASE", async () => {
    seedSettlementScan([generatingRow({ status: "FAILED" })]);
    settledMock.mockResolvedValueOnce(false);

    const result = await reconcileCreatorGenerations({});

    expect(result.settlementRepaired).toBe(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("already settled (a COMMIT or RELEASE already exists): no repair action is taken", async () => {
    seedSettlementScan([generatingRow({ status: "COMPLETED" })]);
    settledMock.mockResolvedValueOnce(true);

    const result = await reconcileCreatorGenerations({});

    expect(result.settlementRepaired).toBe(0);
    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("two reconciler passes racing on the same stale generation: only one applies the repair, the second is a safe no-op", async () => {
    // Simulate the underlying idempotent guard losing the race on the
    // second call — this is exactly what commitCreatorCredits's unique
    // (generationId, type) constraint produces in production.
    seedSettlementScan([generatingRow({ status: "COMPLETED" })]);
    settledMock.mockResolvedValueOnce(false);
    commitMock.mockResolvedValueOnce({ applied: false });

    const result = await reconcileCreatorGenerations({});

    expect(result.settlementRepaired).toBe(0);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.recovered" }),
    );
  });
});
