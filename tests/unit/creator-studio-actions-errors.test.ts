import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creator Studio server actions return their result to the browser, so an unexpected failure
 * (a provider response body, a database error) must surface only as a fixed code — never its
 * message. Errors the services raise deliberately for the user keep the text the UI shows today.
 */
const m = vi.hoisted(() => ({
  requestCharacterImageGeneration: vi.fn(),
  requestImageFromCharacterGeneration: vi.fn(),
  requestVideoFromImageGeneration: vi.fn(),
  requestCaptionGeneration: vi.fn(),
  confirmCreatorConsent: vi.fn(),
  setCampaignAutopilot: vi.fn(),
  updatePostContent: vi.fn(),
  schedulePost: vi.fn(),
  connectSocialAccount: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1" })),
}));
vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { creatorGenerate: { limit: vi.fn(async () => ({ success: true })) } },
}));
vi.mock("@/server/services/creator-generations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestCharacterImageGeneration: m.requestCharacterImageGeneration,
  requestImageFromCharacterGeneration: m.requestImageFromCharacterGeneration,
  requestVideoFromImageGeneration: m.requestVideoFromImageGeneration,
  requestCaptionGeneration: m.requestCaptionGeneration,
}));
vi.mock("@/server/services/creator-profiles", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmCreatorConsent: m.confirmCreatorConsent,
}));
vi.mock("@/server/services/creator-campaigns", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setCampaignAutopilot: m.setCampaignAutopilot,
}));
vi.mock("@/server/services/creator-posts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updatePostContent: m.updatePostContent,
  schedulePost: m.schedulePost,
}));
vi.mock("@/server/services/creator-social-accounts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  connectSocialAccount: m.connectSocialAccount,
}));

import {
  confirmConsentAction,
  connectSocialAccountAction,
  generateCaptionAction,
  generateCharacterImageAction,
  generateImageFromCharacterAction,
  generateVideoFromImageAction,
  schedulePostAction,
  setCampaignAutopilotAction,
  updatePostContentAction,
} from "@/actions/creator-studio";
import { FalRequestError } from "@/server/integrations/fal";
import { InsufficientCreditsError } from "@/server/services/creator-credits";
import { CreatorMediaProviderUnavailableError } from "@/server/ai/creator/router";
import { CreatorProfileError } from "@/server/services/creator-profiles";
import { CampaignError } from "@/server/services/creator-campaigns";
import { PostWorkflowError } from "@/server/services/creator-posts";
import { SocialConnectError } from "@/server/services/creator-social-accounts";

const PROFILE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const SECRET = "provider-body-SECRET-detail";

const rawProviderError = () =>
  new FalRequestError(500, `fal.ai request failed (500): {"detail":"${SECRET}"}`);
const rawDatabaseError = () =>
  new Error(`Invalid \`prisma.creatorPost.update()\` invocation: where id = '${SECRET}'`);

type Case = {
  name: string;
  service: ReturnType<typeof vi.fn>;
  run: () => Promise<{ error?: string }>;
  fallback: string;
  userFacing: Error;
};

const cases: Case[] = [
  {
    name: "generateCharacterImageAction",
    service: m.requestCharacterImageGeneration,
    run: () =>
      generateCharacterImageAction({
        creatorProfileId: PROFILE,
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    fallback: "generation_failed",
    userFacing: new InsufficientCreditsError(
      "Insufficient Creator Studio credits for this generation.",
    ),
  },
  {
    name: "generateImageFromCharacterAction",
    service: m.requestImageFromCharacterGeneration,
    run: () =>
      generateImageFromCharacterAction({
        creatorProfileId: PROFILE,
        prompt: "a portrait",
        aspectRatio: "1:1",
      }),
    fallback: "generation_failed",
    userFacing: new CreatorMediaProviderUnavailableError(),
  },
  {
    name: "generateVideoFromImageAction",
    service: m.requestVideoFromImageGeneration,
    run: () => generateVideoFromImageAction({ sourceAssetId: ASSET, aspectRatio: "9:16" }),
    fallback: "generation_failed",
    userFacing: new CreatorProfileError("consent_required", "Creator consent is required."),
  },
  {
    name: "generateCaptionAction",
    service: m.requestCaptionGeneration,
    run: () => generateCaptionAction({ platform: "INSTAGRAM", language: "EN" }),
    fallback: "generation_failed",
    userFacing: new InsufficientCreditsError(
      "Insufficient Creator Studio credits for this generation.",
    ),
  },
  {
    name: "confirmConsentAction",
    service: m.confirmCreatorConsent,
    run: () => confirmConsentAction(PROFILE),
    fallback: "failed",
    userFacing: new CreatorProfileError("not_found", "Creator profile not found."),
  },
  {
    name: "setCampaignAutopilotAction",
    service: m.setCampaignAutopilot,
    run: () => setCampaignAutopilotAction(PROFILE, { enabled: false }),
    fallback: "failed",
    userFacing: new CampaignError("not_found", "Campaign not found."),
  },
  {
    name: "updatePostContentAction",
    service: m.updatePostContent,
    run: () => updatePostContentAction(PROFILE, { caption: "hello" }),
    fallback: "failed",
    userFacing: new PostWorkflowError("invalid_state", "Post can no longer be edited."),
  },
  {
    name: "schedulePostAction",
    service: m.schedulePost,
    run: () =>
      schedulePostAction(PROFILE, {
        scheduledFor: "2030-01-01T10:00:00.000Z",
        socialAccountId: ACCOUNT,
      }),
    fallback: "failed",
    userFacing: new PostWorkflowError("not_approved", "Post must be approved first."),
  },
  {
    name: "connectSocialAccountAction",
    service: m.connectSocialAccount,
    run: () => connectSocialAccountAction({ platform: "INSTAGRAM", authCode: "code" }),
    fallback: "connect_failed",
    userFacing: new SocialConnectError("Meta Graph API is not configured", "not_configured"),
  },
];

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("Creator Studio server action errors", () => {
  for (const c of cases) {
    it(`${c.name} returns only a fixed code for a raw provider error`, async () => {
      c.service.mockRejectedValueOnce(rawProviderError());
      const result = await c.run();
      expect(result).toEqual({ error: c.fallback });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it(`${c.name} returns only a fixed code for a raw database error`, async () => {
      c.service.mockRejectedValueOnce(rawDatabaseError());
      const result = await c.run();
      expect(result).toEqual({ error: c.fallback });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it(`${c.name} keeps the user-facing message of a deliberate service error`, async () => {
      c.service.mockRejectedValueOnce(c.userFacing);
      expect(await c.run()).toEqual({ error: c.userFacing.message });
    });
  }

  it("logs an unexpected failure server-side by class name only", async () => {
    m.requestCaptionGeneration.mockRejectedValueOnce(rawProviderError());
    await generateCaptionAction({ platform: "INSTAGRAM", language: "EN" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls)).toContain("FalRequestError");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SECRET);
  });
});
