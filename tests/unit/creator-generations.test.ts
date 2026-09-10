import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type * as CreatorCreditsModule from "@/server/services/creator-credits";

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
    commitMock: vi.fn(async () => undefined),
    releaseMock: vi.fn(async () => undefined),
    providerMock: {
      name: "mock",
      generateCharacterImage: vi.fn(),
      generateImageFromCharacter: vi.fn(),
      generateVideoFromImage: vi.fn(),
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
          where: { id: string; status?: string };
          data: Record<string, unknown>;
        }) => {
          if (where.status && generation.status !== where.status) return { count: 0 };
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

    expect(result.status).toBe("COMPLETED");
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

    expect(result.status).toBe("COMPLETED");
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

    expect(result.status).toBe("COMPLETED");
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

    expect(result.status).toBe("COMPLETED");
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(db.creatorGeneration.updateMany).toHaveBeenCalledTimes(1);
  });
});
