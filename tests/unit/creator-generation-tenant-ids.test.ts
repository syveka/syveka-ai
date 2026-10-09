import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * The creator profile and template foreign keys don't check the organization. A generation
 * must never store, attach output to, or read reference images through another
 * organization's profile or template id supplied by the client.
 */
const m = vi.hoisted(() => ({
  profileFindFirst: vi.fn(),
  profileFindFirstOrThrow: vi.fn(),
  sourceAssetFindFirstOrThrow: vi.fn(),
  templateFindFirst: vi.fn(),
  reserve: vi.fn(async () => undefined),
  generationCreate: vi.fn(),
  provider: {
    name: "mock",
    generateCharacterImage: vi.fn(),
    generateVideoFromImage: vi.fn(),
    cleanupGeneratedOutput: vi.fn(),
  },
  captionProvider: { name: "mock", generateCaption: vi.fn() },
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    creatorProfile: {
      findFirst: m.profileFindFirst,
      findFirstOrThrow: m.profileFindFirstOrThrow,
    },
    creatorReferenceAsset: { findFirstOrThrow: m.sourceAssetFindFirstOrThrow },
    creatorGeneration: { create: m.generationCreate },
  }),
  unscopedPrisma: { creatorTemplate: { findFirst: m.templateFindFirst } },
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-credits", () => ({
  getCreatorGenerationCreditCost: vi.fn(() => 10),
  reserveCreatorCredits: m.reserve,
  commitCreatorCredits: vi.fn(),
  releaseCreatorCredits: vi.fn(),
  InsufficientCreditsError: class extends Error {},
}));
vi.mock("@/server/ai/creator", () => ({
  getCreatorMediaProvider: () => m.provider,
  getCreatorCaptionProvider: () => m.captionProvider,
}));
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: vi.fn(async () => null),
  buildBusinessDnaPromptBlock: vi.fn(() => null),
}));

import {
  requestCaptionGeneration,
  requestCharacterImageGeneration,
  requestVideoFromImageGeneration,
} from "@/server/services/creator-generations";

const ctx: TenantContext = {
  userId: "user-1",
  email: "u@example.com",
  orgId: "org-a",
  role: "MANAGER",
  locale: "en",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.sourceAssetFindFirstOrThrow.mockResolvedValue({
    id: "asset-1",
    creatorProfileId: "profile-a",
    storagePath: "org-a/x.png",
    source: "GENERATED",
  });
  m.profileFindFirstOrThrow.mockResolvedValue({
    id: "profile-a",
    consentConfirmedAt: new Date(),
    referenceAssets: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
  });
});

function expectNothingStarted() {
  expect(m.generationCreate).not.toHaveBeenCalled();
  expect(m.reserve).not.toHaveBeenCalled();
  expect(m.provider.generateVideoFromImage).not.toHaveBeenCalled();
  expect(m.provider.generateCharacterImage).not.toHaveBeenCalled();
  expect(m.captionProvider.generateCaption).not.toHaveBeenCalled();
}

describe("creator generations only accept this organization's ids", () => {
  it("refuses another organization's profile id for video-from-image", async () => {
    m.profileFindFirst.mockResolvedValueOnce(null);
    await expect(
      requestVideoFromImageGeneration(ctx, {
        sourceAssetId: "asset-1",
        creatorProfileId: "profile-of-org-b",
        aspectRatio: "9:16",
      }),
    ).rejects.toMatchObject({ code: "profile_not_found" });
    expectNothingStarted();
  });

  it("refuses another organization's profile id for captions", async () => {
    m.profileFindFirst.mockResolvedValueOnce(null);
    await expect(
      requestCaptionGeneration(ctx, {
        platform: "instagram",
        language: "EN",
        creatorProfileId: "profile-of-org-b",
      }),
    ).rejects.toMatchObject({ code: "profile_not_found" });
    expectNothingStarted();
  });

  it("refuses another organization's template id, and accepts only global or own templates", async () => {
    m.templateFindFirst.mockResolvedValueOnce(null);
    await expect(
      requestCharacterImageGeneration(ctx, {
        creatorProfileId: "profile-a",
        templateId: "template-of-org-b",
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    ).rejects.toMatchObject({ code: "template_not_found" });
    expect(m.templateFindFirst).toHaveBeenCalledWith({
      where: {
        id: "template-of-org-b",
        OR: [{ organizationId: null }, { organizationId: "org-a" }],
      },
      select: { id: true },
    });
    expectNothingStarted();
  });

  it("reads a profile's reference images only from this organization", async () => {
    m.templateFindFirst.mockResolvedValueOnce(null);
    await requestCharacterImageGeneration(ctx, {
      creatorProfileId: "profile-a",
      templateId: "t",
      prompt: "a portrait",
      aspectRatio: "1:1",
    }).catch(() => undefined);
    const include = m.profileFindFirstOrThrow.mock.calls[0]![0].include;
    expect(include.referenceAssets.where).toMatchObject({ organizationId: "org-a" });
  });
});
