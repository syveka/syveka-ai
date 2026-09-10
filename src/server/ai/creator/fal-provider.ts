import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { runFalModel, isFalConfigured } from "@/server/integrations/fal";
import type { FalSubmissionInfo } from "@/server/integrations/fal";
import type {
  CreatorMediaProvider,
  CharacterImageRequest,
  ImageFromCharacterRequest,
  VideoFromImageRequest,
  MediaGenerationResult,
  VideoGenerationResult,
  CreatorAssetRef,
  OnProviderSubmitted,
} from "./types";

const REFERENCE_BUCKET = "creator-reference-assets";
const OUTPUT_BUCKET = "creator-generated-media";
const SIGNED_URL_TTL_SECONDS = 600;

const DEFAULT_IMAGE_MODEL = "fal-ai/flux/schnell";
const DEFAULT_IMAGE_TO_IMAGE_MODEL = "fal-ai/flux/dev/image-to-image";
// v1.5 Standard is no longer present in fal.ai's current model catalog (confirmed
// during live E2E testing); v2.1 Standard uses the same request shape and has been
// proven live against the real fal.ai queue API.
const DEFAULT_IMAGE_TO_VIDEO_MODEL = "fal-ai/kling-video/v2.1/standard/image-to-video";

function imageModel(): string {
  return process.env.FAL_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}
function imageToVideoModel(): string {
  return process.env.FAL_IMAGE_TO_VIDEO_MODEL || DEFAULT_IMAGE_TO_VIDEO_MODEL;
}

/** Wraps a caller's onProviderSubmitted with the model (and, for video, the
 * requested duration) that isn't otherwise visible to runFalModel's callback. */
function withSubmissionMeta(
  extra: { model: string; durationSeconds?: number },
  cb?: OnProviderSubmitted,
): ((info: FalSubmissionInfo) => Promise<void>) | undefined {
  if (!cb) return undefined;
  return async (info: FalSubmissionInfo) => cb({ ...info, ...extra });
}

function falImageSize(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case "1:1":
      return { width: 1024, height: 1024 };
    case "4:5":
      return { width: 1024, height: 1280 };
    case "9:16":
      return { width: 768, height: 1344 };
    case "16:9":
      return { width: 1344, height: 768 };
    default:
      return { width: 1024, height: 1024 };
  }
}

/**
 * Signs a creator asset for fal.ai to fetch as input. An asset's storage
 * bucket depends on its source (UPLOAD → reference bucket, GENERATED →
 * generated-media bucket) — same rule as creator-publishing.ts's
 * signAssetUrl, which every other asset-signing call site in Creator Studio
 * already follows.
 */
async function signAsset(asset: CreatorAssetRef): Promise<string> {
  const bucket = asset.source === "GENERATED" ? OUTPUT_BUCKET : REFERENCE_BUCKET;
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrl(asset.storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`Failed to sign asset for fal.ai input: ${error?.message}`);
  }
  return data.signedUrl;
}

/**
 * Downloads a fal.ai output URL and re-uploads it into our own storage, so
 * the org owns the asset (not a third-party CDN link that can
 * expire/rotate). Exported so the crash-recovery reconciler can reuse the
 * exact same download/persist path for a job it recovers rather than
 * reimplementing it.
 */
export async function persistFalOutput(
  url: string,
  contentType: string,
  extension: string,
): Promise<{ storagePath: string; mimeType: string; sizeBytes: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download fal.ai output (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const admin = createSupabaseAdmin();
  const storagePath = `fal/${randomUUID()}.${extension}`;
  const { error } = await admin.storage.from(OUTPUT_BUCKET).upload(storagePath, bytes, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Failed to persist fal.ai output to storage: ${error.message}`);

  // Derived from the exact bytes just uploaded, not a provider-declared or
  // separately-fetched size — always matches the real Storage object length.
  return { storagePath, mimeType: contentType, sizeBytes: bytes.length };
}

export type FalImageOutput = {
  images: Array<{ url: string; content_type?: string }>;
};

export type FalVideoOutput = {
  video: { url: string; content_type?: string };
};

/** Interprets a fal.ai image-model response into a downloadable url/contentType/extension — exported so a recovered job's response can be finalized through the exact same logic as a live one. */
export function interpretFalImageOutput(output: FalImageOutput): {
  url: string;
  contentType: string;
  extension: string;
} {
  const image = output.images[0];
  if (!image) throw new Error("fal.ai returned no images");
  const contentType = image.content_type ?? "image/png";
  const extension = contentType.includes("jpeg")
    ? "jpg"
    : contentType.includes("webp")
      ? "webp"
      : "png";
  return { url: image.url, contentType, extension };
}

/** Interprets a fal.ai video-model response — same purpose as interpretFalImageOutput. */
export function interpretFalVideoOutput(output: FalVideoOutput): {
  url: string;
  contentType: string;
  extension: string;
} {
  return {
    url: output.video.url,
    contentType: output.video.content_type ?? "video/mp4",
    extension: "mp4",
  };
}

/**
 * Real image/video generation via fal.ai (Kling for video, FLUX for image —
 * both cost-efficient, production-capable, and available without a
 * dedicated enterprise contract, unlike e.g. Veo). Used automatically
 * instead of the mock provider whenever FAL_API_KEY is configured — see
 * ../router.ts, which resolves this per-capability so a premium provider
 * (Veo, etc.) can be registered later without touching call sites.
 *
 * Known, disclosed limitation: neither FLUX nor this integration performs
 * identity-locking / LoRA-style character-consistency conditioning from the
 * creator's reference photos — generateImageFromCharacter uses one
 * reference image only as an image-to-image style/composition guide
 * (`strength` below), not a face-identity lock. True consistent-character
 * generation needs a per-character LoRA or IP-Adapter pipeline, which is
 * out of scope for this pass — see docs/creator-studio.md.
 */
export class FalCreatorMediaProvider implements CreatorMediaProvider {
  readonly name = "fal";

  async generateCharacterImage(req: CharacterImageRequest): Promise<MediaGenerationResult> {
    const start = Date.now();
    const size = falImageSize(req.aspectRatio);
    const model = imageModel();
    const output = await runFalModel<FalImageOutput>(
      model,
      { prompt: req.prompt, image_size: size, num_images: 1 },
      undefined,
      withSubmissionMeta({ model }, req.onProviderSubmitted),
    );
    return this.persistFirstImage(output, start);
  }

  async generateImageFromCharacter(req: ImageFromCharacterRequest): Promise<MediaGenerationResult> {
    const start = Date.now();
    const size = falImageSize(req.aspectRatio);
    if (req.referenceAssets.length === 0) {
      const model = imageModel();
      const output = await runFalModel<FalImageOutput>(
        model,
        {
          prompt: req.prompt,
          negative_prompt: req.negativePrompt,
          image_size: size,
          num_images: 1,
        },
        undefined,
        withSubmissionMeta({ model }, req.onProviderSubmitted),
      );
      return this.persistFirstImage(output, start);
    }

    const referenceUrl = await signAsset(req.referenceAssets[0]!);
    const model = DEFAULT_IMAGE_TO_IMAGE_MODEL;
    const output = await runFalModel<FalImageOutput>(
      model,
      { prompt: req.prompt, image_url: referenceUrl, strength: 0.75, image_size: size },
      undefined,
      withSubmissionMeta({ model }, req.onProviderSubmitted),
    );
    return this.persistFirstImage(output, start);
  }

  async generateVideoFromImage(req: VideoFromImageRequest): Promise<VideoGenerationResult> {
    const start = Date.now();
    const sourceUrl = await signAsset(req.sourceAsset);
    const duration = req.durationSeconds && req.durationSeconds >= 8 ? "10" : "5";
    const model = imageToVideoModel();
    const output = await runFalModel<FalVideoOutput>(
      model,
      {
        prompt: req.motionPrompt ?? "Animate this image with subtle natural motion.",
        image_url: sourceUrl,
        duration,
      },
      undefined,
      withSubmissionMeta({ model, durationSeconds: Number(duration) }, req.onProviderSubmitted),
    );
    const { url, contentType, extension } = interpretFalVideoOutput(output);
    const { storagePath, mimeType, sizeBytes } = await persistFalOutput(
      url,
      contentType,
      extension,
    );
    return {
      outputStoragePath: storagePath,
      mimeType,
      sizeBytes,
      providerRequestId: url,
      latencyMs: Date.now() - start,
      durationSeconds: Number(duration),
    };
  }

  private async persistFirstImage(
    output: FalImageOutput,
    start: number,
  ): Promise<MediaGenerationResult> {
    const { url, contentType, extension } = interpretFalImageOutput(output);
    const { storagePath, mimeType, sizeBytes } = await persistFalOutput(
      url,
      contentType,
      extension,
    );
    return {
      outputStoragePath: storagePath,
      mimeType,
      sizeBytes,
      providerRequestId: url,
      latencyMs: Date.now() - start,
    };
  }
}

export { isFalConfigured };
