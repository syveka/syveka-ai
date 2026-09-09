import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { runFalModel, isFalConfigured } from "@/server/integrations/fal";
import type {
  CreatorMediaProvider,
  CharacterImageRequest,
  ImageFromCharacterRequest,
  VideoFromImageRequest,
  MediaGenerationResult,
  VideoGenerationResult,
} from "./types";

const REFERENCE_BUCKET = "creator-reference-assets";
const OUTPUT_BUCKET = "creator-generated-media";
const SIGNED_URL_TTL_SECONDS = 600;

const DEFAULT_IMAGE_MODEL = "fal-ai/flux/schnell";
const DEFAULT_IMAGE_TO_IMAGE_MODEL = "fal-ai/flux/dev/image-to-image";
const DEFAULT_IMAGE_TO_VIDEO_MODEL = "fal-ai/kling-video/v1.5/standard/image-to-video";

function imageModel(): string {
  return process.env.FAL_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}
function imageToVideoModel(): string {
  return process.env.FAL_IMAGE_TO_VIDEO_MODEL || DEFAULT_IMAGE_TO_VIDEO_MODEL;
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

async function signReferenceAsset(storagePath: string): Promise<string> {
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(REFERENCE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`Failed to sign reference asset for fal.ai input: ${error?.message}`);
  }
  return data.signedUrl;
}

/** Downloads a fal.ai output URL and re-uploads it into our own storage, so the org owns the asset (not a third-party CDN link that can expire/rotate). */
async function persistFalOutput(
  url: string,
  contentType: string,
  extension: string,
): Promise<{ storagePath: string; mimeType: string }> {
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

  return { storagePath, mimeType: contentType };
}

type FalImageOutput = {
  images: Array<{ url: string; content_type?: string }>;
};

type FalVideoOutput = {
  video: { url: string; content_type?: string };
};

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
    const output = await runFalModel<FalImageOutput>(imageModel(), {
      prompt: req.prompt,
      image_size: size,
      num_images: 1,
    });
    return this.persistFirstImage(output, start);
  }

  async generateImageFromCharacter(req: ImageFromCharacterRequest): Promise<MediaGenerationResult> {
    const start = Date.now();
    const size = falImageSize(req.aspectRatio);
    if (req.referenceAssetPaths.length === 0) {
      const output = await runFalModel<FalImageOutput>(imageModel(), {
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        image_size: size,
        num_images: 1,
      });
      return this.persistFirstImage(output, start);
    }

    const referenceUrl = await signReferenceAsset(req.referenceAssetPaths[0]!);
    const output = await runFalModel<FalImageOutput>(DEFAULT_IMAGE_TO_IMAGE_MODEL, {
      prompt: req.prompt,
      image_url: referenceUrl,
      strength: 0.75,
      image_size: size,
    });
    return this.persistFirstImage(output, start);
  }

  async generateVideoFromImage(req: VideoFromImageRequest): Promise<VideoGenerationResult> {
    const start = Date.now();
    const sourceUrl = await signReferenceAsset(req.sourceAssetPath);
    const duration = req.durationSeconds && req.durationSeconds >= 8 ? "10" : "5";
    const output = await runFalModel<FalVideoOutput>(imageToVideoModel(), {
      prompt: req.motionPrompt ?? "Animate this image with subtle natural motion.",
      image_url: sourceUrl,
      duration,
    });
    const contentType = output.video.content_type ?? "video/mp4";
    const { storagePath, mimeType } = await persistFalOutput(output.video.url, contentType, "mp4");
    return {
      outputStoragePath: storagePath,
      mimeType,
      providerRequestId: output.video.url,
      latencyMs: Date.now() - start,
      durationSeconds: Number(duration),
    };
  }

  private async persistFirstImage(
    output: FalImageOutput,
    start: number,
  ): Promise<MediaGenerationResult> {
    const image = output.images[0];
    if (!image) throw new Error("fal.ai returned no images");
    const contentType = image.content_type ?? "image/png";
    const ext = contentType.includes("jpeg")
      ? "jpg"
      : contentType.includes("webp")
        ? "webp"
        : "png";
    const { storagePath, mimeType } = await persistFalOutput(image.url, contentType, ext);
    return {
      outputStoragePath: storagePath,
      mimeType,
      providerRequestId: image.url,
      latencyMs: Date.now() - start,
    };
  }
}

export { isFalConfigured };
