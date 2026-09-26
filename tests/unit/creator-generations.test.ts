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

import {
  claimGenerationCompleted,
  isRecordableModel,
  requestCharacterImageGeneration,
} from "@/server/services/creator-generations";

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
    // The row ends up COMPLETED, and completion keeps the durable submission
    // record instead of overwriting it with the output url, so the provider
    // request id and the endpoint actually submitted survive.
    expect(db.generation.status).toBe("COMPLETED");
    expect(JSON.parse(db.generation.providerRequestId as string)).toEqual({
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/x/status",
      responseUrl: "https://queue.fal.run/x",
      model: "fal-ai/flux/schnell",
    });
    expect(db.generation.providerRequestId).not.toContain("fal.media/out.png");
    // The real endpoint replaces the "default" placeholder in the model column.
    expect(db.generation.model).toBe("fal-ai/flux/schnell");
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

describe("durable provider metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const submission = {
    requestId: "req-9",
    statusUrl: "https://queue.fal.run/y/status",
    responseUrl: "https://queue.fal.run/y",
    model: "fal-ai/flux/dev/image-to-image",
  };
  const falResult = {
    outputStoragePath: "fal/out.jpeg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    providerRequestId: "https://fal.media/out.jpeg",
    latencyMs: 400,
  };

  it("records the actual submitted endpoint (e.g. a template/override path), not 'default'", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockImplementationOnce(
      async (req: CharacterImageRequest) => {
        await req.onProviderSubmitted!(submission);
        return falResult;
      },
    );
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });
    expect(db.generation.model).toBe("fal-ai/flux/dev/image-to-image");
    expect(JSON.parse(db.generation.providerRequestId as string)).toEqual(submission);
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1);
  });

  it("keeps the submission identity and endpoint through a failure after submission", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockImplementationOnce(
      async (req: CharacterImageRequest) => {
        await req.onProviderSubmitted!(submission);
        throw new Error("fal job failed");
      },
    );
    await expect(
      requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("fal job failed");
    expect(db.generation.status).toBe("FAILED");
    expect(JSON.parse(db.generation.providerRequestId as string)).toEqual(submission);
    expect(db.generation.model).toBe("fal-ai/flux/dev/image-to-image");
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("still records the completion id for a provider that never submits an identity (mock)", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockResolvedValueOnce({
      ...falResult,
      providerRequestId: "mock_abc",
    });
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });
    expect(db.generation.status).toBe("COMPLETED");
    expect(db.generation.providerRequestId).toBe("mock_abc");
    // Nothing was submitted, so nothing is invented: the placeholder stays.
    expect(db.generation.model).toBe("default");
  });

  it("does not record a malformed endpoint, but still stores the submission identity", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    providerMock.generateCharacterImage.mockImplementationOnce(
      async (req: CharacterImageRequest) => {
        await req.onProviderSubmitted!({ ...submission, model: "https://evil.example/x" });
        return falResult;
      },
    );
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });
    expect(db.generation.model).toBe("default");
    expect(JSON.parse(db.generation.providerRequestId as string).requestId).toBe("req-9");
  });

  it("recovery-style completion keeps an existing record and commits once; a repeat is a no-op", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    Object.assign(db.generation, {
      id: "gen-1",
      status: "GENERATING",
      model: "fal-ai/flux/schnell",
      providerRequestId: JSON.stringify({ ...submission, model: "fal-ai/flux/schnell" }),
    });
    const result = {
      outputAssetIds: ["out-1"],
      providerRequestId: "https://fal.media/r.jpeg",
      latencyMs: 1,
    };
    await expect(claimGenerationCompleted(ctx(), "gen-1", "IMAGE", 20, result)).resolves.toEqual({
      claimed: true,
    });
    await expect(claimGenerationCompleted(ctx(), "gen-1", "IMAGE", 20, result)).resolves.toEqual({
      claimed: false,
    });
    expect(JSON.parse(db.generation.providerRequestId as string).model).toBe("fal-ai/flux/schnell");
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it("leaves legacy completed rows (URL-shaped id, 'default' model) untouched", async () => {
    const db = makeDb();
    tenantDbMock.mockReturnValue(db);
    Object.assign(db.generation, {
      id: "gen-1",
      status: "COMPLETED",
      model: "default",
      providerRequestId: "https://fal.media/legacy.jpeg",
    });
    await expect(
      claimGenerationCompleted(ctx(), "gen-1", "IMAGE", 20, {
        outputAssetIds: ["out-1"],
        providerRequestId: "https://fal.media/other.jpeg",
        latencyMs: 1,
      }),
    ).resolves.toEqual({ claimed: false });
    expect(db.generation.providerRequestId).toBe("https://fal.media/legacy.jpeg");
    expect(db.generation.model).toBe("default");
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("accepts only plausible endpoint ids", () => {
    expect(isRecordableModel("fal-ai/flux/schnell")).toBe(true);
    expect(isRecordableModel("fal-ai/kling-video/v2.1/standard/image-to-video")).toBe(true);
    for (const bad of ["", "default ", "https://x.example/y", 7, null, "a".repeat(201)]) {
      expect(isRecordableModel(bad)).toBe(false);
    }
  });
});
