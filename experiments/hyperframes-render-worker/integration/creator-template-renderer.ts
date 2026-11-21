import type {
  AspectRatio,
  CaptionLanguage,
  CreatorAssetRef,
  VideoGenerationResult,
} from "@/server/ai/creator/types";

/**
 * The seam between Creator Studio and a template renderer. Nothing in `src/` imports this:
 * it exists so the root typecheck proves the pilot's contract lines up with Creator Studio's
 * real types, and so a later, separately approved change has one small thing to wire up.
 *
 * Hybrid flow: AI footage from the existing provider → validated asset → template → video.
 * The existing generation pipeline stays as it is; this only consumes its finished output.
 */
export interface TemplateRenderRequest {
  template: "product-ad" | "local-service" | "social-announcement";
  language: CaptionLanguage;
  aspectRatio: AspectRatio;
  brand: string;
  headline: string;
  description?: string;
  callToAction: string;
  colors: { background: string; text: string; accent: string; accentText: string };
  logo?: CreatorAssetRef;
  /** Typically the output of `generateVideoFromImage` or an image generation. */
  media?: { kind: "image" | "video"; asset: CreatorAssetRef };
}

export interface CreatorTemplateRenderer {
  readonly name: string;
  render(request: TemplateRenderRequest): Promise<TemplateRenderResult>;
}

export type TemplateRenderResult = Pick<
  VideoGenerationResult,
  "outputStoragePath" | "mimeType" | "sizeBytes" | "latencyMs" | "durationSeconds"
>;

/** Fetches a stored asset into the worker's input directory. Implemented by the caller. */
export type AssetStager = (asset: CreatorAssetRef, targetFileName: string) => Promise<void>;

export class UnsupportedTemplateRequestError extends Error {
  constructor(public readonly code: "unsupported_aspect_ratio") {
    super(code);
    this.name = "UnsupportedTemplateRequestError";
  }
}

export type WorkerRenderSpec = {
  template: TemplateRenderRequest["template"];
  language: "fi" | "en" | "ar";
  aspectRatio: "9:16" | "1:1" | "16:9";
  brand: string;
  headline: string;
  description?: string;
  callToAction: string;
  colors: TemplateRenderRequest["colors"];
  logo?: string;
  media?: { kind: "image" | "video"; file: string };
};

/**
 * Maps a Creator Studio request to the worker's job format. Stored paths never cross over:
 * the worker gets generated file names, so a storage path can't become a path inside the worker.
 * `renderIndex` keeps the renders of one job from overwriting each other's staged files.
 * A stager must load assets through the tenant-scoped path: this function doesn't validate them.
 * Creator Studio also offers 4:5, which the pilot templates don't, and that is refused here
 * rather than cropped.
 */
export async function toWorkerSpec(
  request: TemplateRenderRequest,
  stage: AssetStager,
  renderIndex = 0,
): Promise<WorkerRenderSpec> {
  const { aspectRatio } = request;
  if (aspectRatio === "4:5") {
    throw new UnsupportedTemplateRequestError("unsupported_aspect_ratio");
  }
  const spec: WorkerRenderSpec = {
    template: request.template,
    language: request.language.toLowerCase() as WorkerRenderSpec["language"],
    aspectRatio,
    brand: request.brand,
    headline: request.headline,
    callToAction: request.callToAction,
    colors: request.colors,
    ...(request.description ? { description: request.description } : {}),
  };
  if (request.logo) {
    const file = `logo-${renderIndex}.png`;
    await stage(request.logo, file);
    spec.logo = file;
  }
  if (request.media) {
    const file = `media-${renderIndex}.${request.media.kind === "video" ? "mp4" : "png"}`;
    await stage(request.media.asset, file);
    spec.media = { kind: request.media.kind, file };
  }
  return spec;
}
