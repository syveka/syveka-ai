import { z } from "zod";

export const CREATOR_REFERENCE_ASSET_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const MAX_REFERENCE_ASSET_BYTES = 15 * 1024 * 1024;
export const MIN_REFERENCE_ASSETS = 3;
export const RECOMMENDED_REFERENCE_ASSETS = 8;

export const createCreatorProfileSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const referenceAssetUploadUrlSchema = z
  .object({
    fileName: z.string().min(1).max(200),
    mimeType: z.enum(CREATOR_REFERENCE_ASSET_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_REFERENCE_ASSET_BYTES),
  })
  .strict();

export const confirmReferenceAssetSchema = z
  .object({
    uploadIntentId: z.string().uuid(),
  })
  .strict();

export const confirmConsentSchema = z
  .object({
    consentConfirmed: z.literal(true),
  })
  .strict();

const ASPECT_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;
const QUALITY = ["standard", "high"] as const;

export const generateCharacterImageSchema = z
  .object({
    creatorProfileId: z.string().uuid(),
    templateId: z.string().uuid().optional(),
    prompt: z.string().min(1).max(2_000),
    aspectRatio: z.enum(ASPECT_RATIOS),
    quality: z.enum(QUALITY).optional(),
  })
  .strict();

export const generateImageFromCharacterSchema = z
  .object({
    creatorProfileId: z.string().uuid(),
    templateId: z.string().uuid().optional(),
    prompt: z.string().min(1).max(2_000),
    negativePrompt: z.string().max(1_000).optional(),
    aspectRatio: z.enum(ASPECT_RATIOS),
    quality: z.enum(QUALITY).optional(),
    referenceAssetId: z.string().uuid().optional(),
  })
  .strict();

export const generateVideoFromImageSchema = z
  .object({
    sourceAssetId: z.string().uuid(),
    creatorProfileId: z.string().uuid().optional(),
    motionPrompt: z.string().max(1_000).optional(),
    durationSeconds: z.number().int().min(2).max(30).optional(),
    aspectRatio: z.enum(ASPECT_RATIOS),
    quality: z.enum(QUALITY).optional(),
  })
  .strict();

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "TIKTOK", "YOUTUBE"] as const;
const LANGUAGES = ["EN", "FI", "AR"] as const;

export const generateCaptionSchema = z
  .object({
    platform: z.enum(PLATFORMS),
    language: z.enum(LANGUAGES),
    tone: z.string().max(200).optional(),
    objective: z.string().max(500).optional(),
    creatorProfileId: z.string().uuid().optional(),
    campaignId: z.string().uuid().optional(),
  })
  .strict();

export const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(200),
    objective: z.string().max(500).optional(),
    targetPlatforms: z.array(z.enum(PLATFORMS)).default([]),
    targetLanguages: z.array(z.enum(["EN", "FI", "AR"])).default([]),
    targetPostsPerWeek: z.number().int().min(1).max(50).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    approvalMode: z.enum(["MANUAL", "APPROVAL", "AUTOPILOT"]).default("APPROVAL"),
  })
  .strict();

export const autopilotRulesSchema = z
  .object({
    maxPostsPerWeek: z.number().int().min(1).max(50),
    allowedPlatforms: z.array(z.enum(PLATFORMS)).min(1),
    allowedTemplateCategories: z.array(z.string()).default([]),
    allowedHoursStart: z.number().int().min(0).max(23).default(0),
    allowedHoursEnd: z.number().int().min(0).max(23).default(23),
    monthlyContentLimit: z.number().int().min(1).max(1000).optional(),
    allowedLanguages: z.array(z.enum(LANGUAGES)).min(1),
  })
  .strict();

export const setAutopilotSchema = z
  .object({
    enabled: z.boolean(),
    rules: autopilotRulesSchema.optional(),
  })
  .strict()
  .refine((v) => !v.enabled || v.rules, { message: "rules are required to enable autopilot" });

export const createPostSchema = z
  .object({
    campaignId: z.string().uuid().optional(),
    creatorProfileId: z.string().uuid().optional(),
    assetIds: z.array(z.string().uuid()).min(1),
    caption: z.string().max(2_200).optional(),
    hashtags: z.array(z.string().max(60)).max(30).default([]),
    platform: z.enum(PLATFORMS),
  })
  .strict();

export const updatePostContentSchema = z
  .object({
    caption: z.string().max(2_200).optional(),
    hashtags: z.array(z.string().max(60)).max(30).optional(),
    assetIds: z.array(z.string().uuid()).min(1).optional(),
  })
  .strict();

export const reviewPostSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    note: z.string().max(1_000).optional(),
  })
  .strict();

export const schedulePostSchema = z
  .object({
    scheduledFor: z.coerce.date(),
    socialAccountId: z.string().uuid(),
  })
  .strict();

export const connectSocialAccountSchema = z
  .object({
    platform: z.enum(PLATFORMS),
    authCode: z.string().min(1).max(500),
  })
  .strict();

export type CreateCreatorProfileInput = z.infer<typeof createCreatorProfileSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type AutopilotRules = z.infer<typeof autopilotRulesSchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
