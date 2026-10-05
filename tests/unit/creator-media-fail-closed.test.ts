import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type * as CreatorCreditsModule from "@/server/services/creator-credits";

/**
 * With no real media provider in production, a generation must fail closed
 * before anything is charged or recorded: no credit reservation, no
 * generation row, no provider call, and no mock media. Uses the real
 * provider router (only persistence, credits and audit are faked).
 */

const { tenantDbMock, auditMock, reserveMock, commitMock, releaseMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  reserveMock: vi.fn(async () => undefined),
  commitMock: vi.fn(async () => ({ applied: true })),
  releaseMock: vi.fn(async () => ({ applied: true })),
}));

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock }));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/feature-flags", async (importActual) => ({
  ...(await importActual<object>()),
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-credits", async () => {
  const actual = await vi.importActual<typeof CreatorCreditsModule>(
    "@/server/services/creator-credits",
  );
  return {
    ...actual,
    reserveCreatorCredits: reserveMock,
    commitCreatorCredits: commitMock,
    releaseCreatorCredits: releaseMock,
  };
});

import {
  requestCharacterImageGeneration,
  requestImageFromCharacterGeneration,
  requestVideoFromImageGeneration,
} from "@/server/services/creator-generations";
import { CreatorMediaProviderUnavailableError } from "@/server/ai/creator/router";
import { handleCreatorStudioError } from "@/server/services/creator-studio-http";

const ORIGINAL = {
  falKey: process.env.FAL_API_KEY,
  pin: process.env.CREATOR_MEDIA_PROVIDER,
};

const ctx: TenantContext = {
  userId: "user-1",
  email: "u@example.com",
  orgId: "org-a",
  role: "MANAGER",
  locale: "en",
};

function makeDb() {
  return {
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
    creatorReferenceAsset: {
      findFirstOrThrow: vi.fn(async () => ({
        id: "asset-1",
        storagePath: "org-a/generated/still.png",
        assetType: "IMAGE",
        source: "GENERATED",
      })),
      create: vi.fn(),
    },
    creatorGeneration: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(),
    },
  };
}

const GENERATIONS = [
  [
    "character image",
    () =>
      requestCharacterImageGeneration(ctx, {
        creatorProfileId: "profile-1",
        prompt: "studio portrait",
        aspectRatio: "1:1",
      } as Parameters<typeof requestCharacterImageGeneration>[1]),
  ],
  [
    "image from character",
    () =>
      requestImageFromCharacterGeneration(ctx, {
        creatorProfileId: "profile-1",
        prompt: "at the beach",
        aspectRatio: "1:1",
      } as Parameters<typeof requestImageFromCharacterGeneration>[1]),
  ],
  [
    "video from image",
    () =>
      requestVideoFromImageGeneration(ctx, {
        sourceAssetId: "asset-1",
        motionPrompt: "slow pan",
        durationSeconds: 5,
        aspectRatio: "9:16",
      } as Parameters<typeof requestVideoFromImageGeneration>[1]),
  ],
] as const;

describe("Creator Studio media generation fails closed in production", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.FAL_API_KEY;
    delete process.env.CREATOR_MEDIA_PROVIDER;
    db = makeDb();
    tenantDbMock.mockReturnValue(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (ORIGINAL.falKey === undefined) delete process.env.FAL_API_KEY;
    else process.env.FAL_API_KEY = ORIGINAL.falKey;
    if (ORIGINAL.pin === undefined) delete process.env.CREATOR_MEDIA_PROVIDER;
    else process.env.CREATOR_MEDIA_PROVIDER = ORIGINAL.pin;
  });

  it.each(GENERATIONS)(
    "%s: rejects before reserving credits or creating a generation",
    async (_label, generate) => {
      await expect(generate()).rejects.toBeInstanceOf(CreatorMediaProviderUnavailableError);

      expect(reserveMock).not.toHaveBeenCalled();
      expect(commitMock).not.toHaveBeenCalled();
      expect(releaseMock).not.toHaveBeenCalled();
      expect(db.creatorGeneration.create).not.toHaveBeenCalled();
      expect(db.creatorReferenceAsset.create).not.toHaveBeenCalled();
    },
  );

  it.each(GENERATIONS)(
    "%s: a CREATOR_MEDIA_PROVIDER=mock pin is refused too, before anything is charged",
    async (_label, generate) => {
      process.env.CREATOR_MEDIA_PROVIDER = "mock";
      process.env.FAL_API_KEY = "test-key";

      await expect(generate()).rejects.toBeInstanceOf(CreatorMediaProviderUnavailableError);

      expect(reserveMock).not.toHaveBeenCalled();
      expect(db.creatorGeneration.create).not.toHaveBeenCalled();
      expect(db.creatorReferenceAsset.create).not.toHaveBeenCalled();
    },
  );

  it("maps to 503 with a stable code and no configuration detail", async () => {
    const response = handleCreatorStudioError(new CreatorMediaProviderUnavailableError());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "media_provider_not_configured" } });
  });
});
