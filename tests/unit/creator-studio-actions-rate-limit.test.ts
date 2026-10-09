import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creator Studio generations started from the app's server actions are rate-limited exactly like
 * the /api/v1/creator-studio/generations/* routes: each is a paid provider call.
 */
const m = vi.hoisted(() => ({
  limit: vi.fn(async (_key: string) => ({ success: true })),
  requestCharacterImageGeneration: vi.fn(async () => ({ generation: { id: "g1" } })),
  requestImageFromCharacterGeneration: vi.fn(async () => ({ generation: { id: "g2" } })),
  requestVideoFromImageGeneration: vi.fn(async () => ({ generation: { id: "g3" } })),
  requestCaptionGeneration: vi.fn(async () => ({ generation: { id: "g4" } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1" })),
}));
vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { creatorGenerate: { limit: m.limit } },
}));
vi.mock("@/server/services/creator-generations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestCharacterImageGeneration: m.requestCharacterImageGeneration,
  requestImageFromCharacterGeneration: m.requestImageFromCharacterGeneration,
  requestVideoFromImageGeneration: m.requestVideoFromImageGeneration,
  requestCaptionGeneration: m.requestCaptionGeneration,
}));

import {
  generateCaptionAction,
  generateCharacterImageAction,
  generateImageFromCharacterAction,
  generateVideoFromImageAction,
} from "@/actions/creator-studio";

const PROFILE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";

const actions = [
  () =>
    generateCharacterImageAction({
      creatorProfileId: PROFILE,
      prompt: "a portrait",
      aspectRatio: "1:1",
    }),
  () =>
    generateImageFromCharacterAction({
      creatorProfileId: PROFILE,
      prompt: "a portrait",
      aspectRatio: "1:1",
    }),
  () => generateVideoFromImageAction({ sourceAssetId: ASSET, aspectRatio: "9:16" }),
  () => generateCaptionAction({ platform: "INSTAGRAM", language: "EN" }),
];

const providerCalls = () =>
  m.requestCharacterImageGeneration.mock.calls.length +
  m.requestImageFromCharacterGeneration.mock.calls.length +
  m.requestVideoFromImageGeneration.mock.calls.length +
  m.requestCaptionGeneration.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Creator Studio generation server actions", () => {
  it("apply the per-user generation limit used by the API routes", async () => {
    for (const run of actions) await run();
    expect(m.limit).toHaveBeenCalledTimes(4);
    for (const [key] of m.limit.mock.calls) expect(key).toBe("org-a:user-1");
    expect(providerCalls()).toBe(4);
  });

  it("refuse before any generation once the limit is reached", async () => {
    m.limit.mockResolvedValue({ success: false });
    try {
      for (const run of actions) expect(await run()).toEqual({ error: "rate_limited" });
    } finally {
      m.limit.mockResolvedValue({ success: true });
    }
    expect(providerCalls()).toBe(0);
  });
});
