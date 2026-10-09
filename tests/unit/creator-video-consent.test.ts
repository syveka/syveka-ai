import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Video-from-image animates a likeness, so it must honor the same consent gate as image
 * generation: a source asset (or a client-supplied profile override) that belongs to a creator
 * profile without confirmed consent is refused before any generation row, credit reservation, or
 * provider call. Assets with no profile carry no likeness and are unaffected.
 */
const m = vi.hoisted(() => ({
  profileFindFirst: vi.fn(),
  sourceAssetFindFirstOrThrow: vi.fn(),
  assetCreate: vi.fn(),
  reserve: vi.fn(async () => undefined),
  commit: vi.fn(async () => ({ applied: true })),
  release: vi.fn(async () => ({ applied: true })),
  generationCreate: vi.fn(),
  generationUpdate: vi.fn(),
  generationUpdateMany: vi.fn(async () => ({ count: 1 })),
  generationFindUniqueOrThrow: vi.fn(),
  provider: {
    name: "mock",
    generateVideoFromImage: vi.fn(),
    cleanupGeneratedOutput: vi.fn(),
  },
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    creatorProfile: { findFirst: m.profileFindFirst },
    creatorReferenceAsset: {
      findFirstOrThrow: m.sourceAssetFindFirstOrThrow,
      create: m.assetCreate,
    },
    creatorGeneration: {
      create: m.generationCreate,
      update: m.generationUpdate,
      updateMany: m.generationUpdateMany,
      findFirst: vi.fn(async () => null),
      findUniqueOrThrow: m.generationFindUniqueOrThrow,
    },
  }),
  unscopedPrisma: {},
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-credits", () => ({
  getCreatorGenerationCreditCost: vi.fn(() => 10),
  reserveCreatorCredits: m.reserve,
  commitCreatorCredits: m.commit,
  releaseCreatorCredits: m.release,
  InsufficientCreditsError: class extends Error {},
}));
vi.mock("@/server/ai/creator", () => ({
  getCreatorMediaProvider: () => m.provider,
  getCreatorCaptionProvider: vi.fn(),
}));

import { requestVideoFromImageGeneration } from "@/server/services/creator-generations";

const ctx: TenantContext = {
  userId: "user-1",
  email: "u@example.com",
  orgId: "org-a",
  role: "MANAGER",
  locale: "en",
};

const PROFILES: Record<string, { id: string; consentConfirmedAt: Date | null }> = {
  "profile-consented": { id: "profile-consented", consentConfirmedAt: new Date() },
  "profile-unconsented": { id: "profile-unconsented", consentConfirmedAt: null },
};

function sourceAsset(creatorProfileId: string | null) {
  return {
    id: "asset-1",
    creatorProfileId,
    storagePath: "org-a/profile/photo.png",
    source: "UPLOAD",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.profileFindFirst.mockImplementation(
    async ({ where }: { where: { id: string } }) => PROFILES[where.id] ?? null,
  );
  const generation: Record<string, unknown> = {};
  m.generationCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    Object.assign(generation, data, { id: "gen-1" }),
  );
  m.generationUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    Object.assign(generation, data),
  );
  m.generationFindUniqueOrThrow.mockImplementation(async () => generation);
  m.assetCreate.mockResolvedValue({ id: "output-asset-1" });
  m.provider.generateVideoFromImage.mockResolvedValue({
    outputStoragePath: "generated/org-a/video.mp4",
    mimeType: "video/mp4",
    sizeBytes: 100,
    durationSeconds: 5,
    providerRequestId: "req-1",
    latencyMs: 1,
  });
});

function expectNothingStarted() {
  expect(m.generationCreate).not.toHaveBeenCalled();
  expect(m.reserve).not.toHaveBeenCalled();
  expect(m.provider.generateVideoFromImage).not.toHaveBeenCalled();
}

describe("video-from-image enforces creator consent", () => {
  it("refuses a source asset whose profile has not confirmed consent", async () => {
    m.sourceAssetFindFirstOrThrow.mockResolvedValue(sourceAsset("profile-unconsented"));
    await expect(
      requestVideoFromImageGeneration(ctx, { sourceAssetId: "asset-1", aspectRatio: "9:16" }),
    ).rejects.toMatchObject({ code: "consent_required" });
    expectNothingStarted();
  });

  it("refuses an unconsented profile supplied as an override, even for a consented asset", async () => {
    m.sourceAssetFindFirstOrThrow.mockResolvedValue(sourceAsset("profile-consented"));
    await expect(
      requestVideoFromImageGeneration(ctx, {
        sourceAssetId: "asset-1",
        creatorProfileId: "profile-unconsented",
        aspectRatio: "9:16",
      }),
    ).rejects.toMatchObject({ code: "consent_required" });
    expectNothingStarted();
  });

  it("allows a source asset whose profile has confirmed consent", async () => {
    m.sourceAssetFindFirstOrThrow.mockResolvedValue(sourceAsset("profile-consented"));
    const { generation } = await requestVideoFromImageGeneration(ctx, {
      sourceAssetId: "asset-1",
      aspectRatio: "9:16",
    });
    expect(generation.id).toBe("gen-1");
    expect(m.reserve).toHaveBeenCalledTimes(1);
    expect(m.provider.generateVideoFromImage).toHaveBeenCalledTimes(1);
  });

  it("allows a source asset with no creator profile", async () => {
    m.sourceAssetFindFirstOrThrow.mockResolvedValue(sourceAsset(null));
    const { generation } = await requestVideoFromImageGeneration(ctx, {
      sourceAssetId: "asset-1",
      aspectRatio: "9:16",
    });
    expect(generation.id).toBe("gen-1");
    expect(m.profileFindFirst).not.toHaveBeenCalled();
    expect(m.reserve).toHaveBeenCalledTimes(1);
    expect(m.provider.generateVideoFromImage).toHaveBeenCalledTimes(1);
  });
});
