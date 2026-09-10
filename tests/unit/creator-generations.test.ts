import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type * as CreatorCreditsModule from "@/server/services/creator-credits";
import type { CharacterImageRequest } from "@/server/ai/creator/types";

/**
 * runGeneration (creator-generations.ts) — the shared reserve -> execute ->
 * commit/release orchestration every Creator Studio generation type shares.
 * Proves the credit-safety invariants from the production-readiness audit:
 * exactly one COMMIT on success, exactly one RELEASE on failure, and never
 * both — via the same conditional-claim (`updateMany` on current status)
 * pattern creator-publishing.ts's publishCreatorPost already uses, so a
 * generation can never be double-finalized even if some future path
 * re-processes the same row.
 */

const { tenantDbMock, auditMock, reserveMock, commitMock, releaseMock, providerMock } = vi.hoisted(
  () => ({
    tenantDbMock: vi.fn(),
    auditMock: vi.fn(async () => undefined),
    reserveMock: vi.fn(async () => undefined),
    commitMock: vi.fn(async () => ({ applied: true })),
    releaseMock: vi.fn(async () => ({ applied: true })),
    providerMock: {
      name: "mock",
      generateCharacterImage: vi.fn(),
      generateImageFromCharacter: vi.fn(),
      generateVideoFromImage: vi.fn(),
      cleanupGeneratedOutput: vi.fn(async (_storagePath: string) => undefined),
    },
  }),
);

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock }));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-credits", async () => {
  const actual = await vi.importActual<typeof CreatorCreditsModule>(
    "@/server/services/creator-credits",
  );
  return {
    ...actual,
    getCreatorGenerationCreditCost: vi.fn(() => 10),
    reserveCreatorCredits: reserveMock,
    commitCreatorCredits: commitMock,
    releaseCreatorCredits: releaseMock,
  };
});
vi.mock("@/server/ai/creator", () => ({
  getCreatorMediaProvider: () => providerMock,
  getCreatorCaptionProvider: vi.fn(),
}));

import { requestCharacterImageGeneration } from "@/server/services/creator-generations";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

function makeDb() {
  const generation: Record<string, unknown> = {};
  return {
    generation,
    creatorProfile: {
      findFirstOrThrow: vi.fn(async () => ({
        id: "profile-1",
        consentConfirmedAt: new Date(),
        referenceAssets: [
          { id: "ref-1", storagePath: "org-a/profile/ref.png", source: "UPLOAD" },
          { id: "ref-2", storagePath: "org-a/profile/ref2.png", source: "UPLOAD" },
          { id: "ref-3", storagePath: "org-a/profile/ref3.png", source: "UPLOAD" },
        ],
      })),
    },
    creatorGeneration: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(generation, data, { id: "gen-1" });
        return generation;
      }),
      // Only the QUEUED -> GENERATING transition still uses a plain update()
      // (runGeneration.ts) — the terminal COMPLETED/FAILED transitions use
      // updateMany() below, guarded on the current status.
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(generation, data);
        return generation;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string; providerRequestId?: null };
          data: Record<string, unknown>;
        }) => {
          if (where.status && generation.status !== where.status) return { count: 0 };
          if (where.providerRequestId === null && generation.providerRequestId != null) {
            return { count: 0 };
          }
          Object.assign(generation, data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => generation),
    },
    creatorReferenceAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "output-asset-1",
        ...data,
      })),
    },
  };
}

describe("runGeneration (via requestCharacterImageGeneration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reserves once and commits exactly once on success — never releases", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockResolvedValueOnce({
      outputStoragePath: "fal/out.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      providerRequestId: "https://fal.media/out.png",
      latencyMs: 500,
    });

    const result = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });

    expect(result.generation.status).toBe("COMPLETED");
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.complete" }),
    );
  });

  it("reserves once and releases exactly once on provider failure — never commits", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockRejectedValueOnce(
      new Error("fal.ai request failed (500): upstream error"),
    );

    await expect(
      requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow();

    expect(db.generation.status).toBe("FAILED");
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.failed" }),
    );
  });

  it("never commits twice if the generation was already finalized out of GENERATING", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockResolvedValueOnce({
      outputStoragePath: "fal/out.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      providerRequestId: "https://fal.media/out.png",
      latencyMs: 500,
    });
    // Simulate the terminal claim losing the race — some other path already
    // finalized this row before this path's own updateMany runs.
    db.creatorGeneration.updateMany.mockImplementationOnce(async () => {
      db.generation.status = "COMPLETED"; // some other path already claimed it
      return { count: 0 };
    });

    const result = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });

    expect(result.generation.status).toBe("COMPLETED");
    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.complete" }),
    );
  });

  it("never releases twice if the generation was already finalized out of GENERATING", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockRejectedValueOnce(new Error("provider exploded"));
    db.creatorGeneration.updateMany.mockImplementationOnce(async () => {
      db.generation.status = "FAILED"; // some other path already claimed it
      return { count: 0 };
    });

    await expect(
      requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow();

    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.failed" }),
    );
  });

  it("keeps the generation COMPLETED, never releases, and never double-commits when credit COMMIT throws after the COMPLETED claim succeeds", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockResolvedValueOnce({
      outputStoragePath: "fal/out.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      providerRequestId: "https://fal.media/out.png",
      latencyMs: 500,
    });
    commitMock.mockRejectedValueOnce(new Error("transient DB error during commit"));

    // The real output already exists at this point — a post-success
    // bookkeeping failure must never surface as a thrown generation error.
    const result = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });

    expect(result.generation.status).toBe("COMPLETED");
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.complete" }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "creator.generation.failed" }),
    );
    // Exactly one updateMany call (the COMPLETED claim) — the FAILED-claim
    // branch must never even be attempted for a post-success bookkeeping
    // failure.
    expect(db.creatorGeneration.updateMany).toHaveBeenCalledTimes(1);
  });

  it("keeps the generation COMPLETED with credits already committed exactly once when audit logging throws after a successful COMMIT", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockResolvedValueOnce({
      outputStoragePath: "fal/out.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      providerRequestId: "https://fal.media/out.png",
      latencyMs: 500,
    });
    auditMock.mockRejectedValueOnce(new Error("audit sink unavailable"));

    const result = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });

    expect(result.generation.status).toBe("COMPLETED");
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(db.creatorGeneration.updateMany).toHaveBeenCalledTimes(1);
  });

  it("persists the provider's request identity, keyed to this generation's own id, before the provider call resolves", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockImplementationOnce(
      async (req: CharacterImageRequest) => {
        // Simulate what fal-provider.ts really does: invoke the callback with
        // the real submission info before the (mocked) provider work "finishes".
        await req.onProviderSubmitted!({
          requestId: "req-1",
          statusUrl: "https://queue.fal.run/x/status",
          responseUrl: "https://queue.fal.run/x",
          model: "fal-ai/flux/schnell",
        });
        return {
          outputStoragePath: "fal/out.png",
          mimeType: "image/png",
          sizeBytes: 1234,
          providerRequestId: "https://fal.media/out.png",
          latencyMs: 500,
        };
      },
    );

    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });

    // The early write used the real generation id created by this same call
    // (not a hardcoded stand-in).
    expect(db.generation.id).toBe("gen-1");
    // The COMPLETED claim's own providerRequestId (the final output url)
    // overwrote the early JSON — the row ends up COMPLETED, not stuck with
    // the mid-flight value.
    expect(db.generation.providerRequestId).toBe("https://fal.media/out.png");
  });

  it("aborts the generation (FAILED + RELEASE) without submitting a second provider call if persisting the request identity fails", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    // Simulate providerRequestId already having a value when the callback
    // runs (the conditional write refuses to overwrite silently), which
    // persistProviderRequestIdentity turns into a thrown error.
    providerMock.generateCharacterImage.mockImplementationOnce(
      async (req: CharacterImageRequest) => {
        db.generation.providerRequestId = "some-earlier-value";
        await req.onProviderSubmitted!({
          requestId: "req-1",
          statusUrl: "https://queue.fal.run/x/status",
          responseUrl: "https://queue.fal.run/x",
          model: "fal-ai/flux/schnell",
        });
        throw new Error("unreachable — onProviderSubmitted should have thrown first");
      },
    );

    await expect(
      requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("Failed to durably record the provider job's identity");

    expect(db.generation.status).toBe("FAILED");
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1); // never retried
  });

  describe("Storage orphan compensation (persistGeneratedAssetWithCleanup)", () => {
    function mockProviderResult() {
      providerMock.generateCharacterImage.mockResolvedValueOnce({
        outputStoragePath: "fal/generated-output.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        providerRequestId: "https://fal.media/out.png",
        latencyMs: 500,
      });
    }

    it("TEST A — DB asset create succeeds: cleanup is never called", async () => {
      const db = makeDb();
      tenantDbMock.mockReturnValue(db);
      mockProviderResult();

      const result = await requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
      });

      expect(result.generation.status).toBe("COMPLETED");
      expect(providerMock.cleanupGeneratedOutput).not.toHaveBeenCalled();
    });

    it("TEST B — DB asset create fails: cleanup is called exactly once with the exact generated storagePath, and the original error propagates", async () => {
      const db = makeDb();
      tenantDbMock.mockReturnValue(db);
      mockProviderResult();
      const dbError = new Error("unique constraint violation");
      db.creatorReferenceAsset.create.mockRejectedValueOnce(dbError);

      await expect(
        requestCharacterImageGeneration(ctx(), {
          creatorProfileId: "profile-1",
          prompt: "a portrait",
          aspectRatio: "1:1",
        }),
      ).rejects.toThrow("unique constraint violation");

      expect(providerMock.cleanupGeneratedOutput).toHaveBeenCalledTimes(1);
      expect(providerMock.cleanupGeneratedOutput).toHaveBeenCalledWith("fal/generated-output.png");
      // The generation still fails and releases normally — the compensation
      // is purely a side effect, not a change to the failure/credit path.
      expect(db.generation.status).toBe("FAILED");
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });

    it("TEST C — DB asset create fails AND cleanup also fails: the original DB error still propagates, cleanup error is only logged, and cleanup is never retried", async () => {
      const db = makeDb();
      tenantDbMock.mockReturnValue(db);
      mockProviderResult();
      const dbError = new Error("unique constraint violation");
      db.creatorReferenceAsset.create.mockRejectedValueOnce(dbError);
      providerMock.cleanupGeneratedOutput.mockRejectedValueOnce(new Error("storage delete failed"));
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        requestCharacterImageGeneration(ctx(), {
          creatorProfileId: "profile-1",
          prompt: "a portrait",
          aspectRatio: "1:1",
        }),
      ).rejects.toThrow("unique constraint violation"); // the DB error, not the cleanup error

      expect(providerMock.cleanupGeneratedOutput).toHaveBeenCalledTimes(1); // never retried
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "failed to clean up an orphaned generated Storage object after DB asset persistence failed",
        expect.objectContaining({ storagePath: "fal/generated-output.png" }),
      );
      consoleErrorSpy.mockRestore();
    });

    it("TEST D — cleanup is never invoked with an uploaded/customer reference asset's path", async () => {
      const db = makeDb();
      tenantDbMock.mockReturnValue(db);
      mockProviderResult();
      db.creatorReferenceAsset.create.mockRejectedValueOnce(new Error("db error"));

      await expect(
        requestCharacterImageGeneration(ctx(), {
          creatorProfileId: "profile-1",
          prompt: "a portrait",
          aspectRatio: "1:1",
        }),
      ).rejects.toThrow();

      // Only ever called with the freshly-generated output path from this
      // exact provider result — never any of the profile's real reference
      // asset paths (org-a/profile/ref*.png from makeDb's fixture).
      for (const call of providerMock.cleanupGeneratedOutput.mock.calls) {
        expect(call[0]).not.toMatch(/^org-a\/profile\/ref/);
      }
      expect(providerMock.cleanupGeneratedOutput).toHaveBeenCalledWith("fal/generated-output.png");
    });

    it("TEST E — no cleanup occurs once an output asset has already been successfully linked", async () => {
      const db = makeDb();
      tenantDbMock.mockReturnValue(db);
      mockProviderResult();

      await requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
      });

      expect(db.creatorReferenceAsset.create).toHaveBeenCalledTimes(1);
      expect(providerMock.cleanupGeneratedOutput).not.toHaveBeenCalled();
    });
  });
});
