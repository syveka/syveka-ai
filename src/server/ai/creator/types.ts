/**
 * Provider-agnostic Creator Studio generation contracts (Phase 3). The
 * frontend and services never see a provider SDK directly — they call
 * getCreatorMediaProvider()/getCreatorCaptionProvider() and depend only on
 * these shapes, so a real image/video vendor can be swapped in later
 * without touching calling code.
 */

export type AspectRatio = "1:1" | "4:5" | "9:16" | "16:9";
export type GenerationQuality = "standard" | "high";

/**
 * A storage-backed asset, identified along with its CreatorAssetSource
 * (UPLOAD vs GENERATED) so a provider can resolve the correct storage
 * bucket — see fal-provider.ts's signAsset, mirroring
 * creator-publishing.ts's signAssetUrl.
 */
export interface CreatorAssetRef {
  storagePath: string;
  source: string;
}

/**
 * The exact identifiers needed to reconnect to an already-accepted provider
 * job from a different process — P0 crash-recovery hardening. `model` is
 * included because a bare provider request id is only useful together with
 * the model it was submitted against (fal.ai's queue URLs are per-model).
 */
export interface ProviderSubmissionInfo {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  model: string;
  /** Set only for video submissions — the reconciler needs this to finish building a VideoGenerationResult from a recovered job, since it isn't derivable from the provider's response alone. */
  durationSeconds?: number;
}

/**
 * Invoked immediately after the provider accepts a job, before any
 * polling/waiting begins, so the caller can durably persist the job's
 * identity. If this throws, the provider method must abort rather than
 * continue polling a job whose identity failed to persist.
 */
export type OnProviderSubmitted = (info: ProviderSubmissionInfo) => Promise<void>;

export interface CharacterImageRequest {
  prompt: string;
  referenceAssets: CreatorAssetRef[];
  aspectRatio: AspectRatio;
  quality?: GenerationQuality;
  onProviderSubmitted?: OnProviderSubmitted;
}

export interface ImageFromCharacterRequest {
  prompt: string;
  negativePrompt?: string;
  referenceAssets: CreatorAssetRef[];
  aspectRatio: AspectRatio;
  quality?: GenerationQuality;
  onProviderSubmitted?: OnProviderSubmitted;
}

export interface VideoFromImageRequest {
  sourceAsset: CreatorAssetRef;
  motionPrompt?: string;
  durationSeconds?: number;
  aspectRatio: AspectRatio;
  quality?: GenerationQuality;
  onProviderSubmitted?: OnProviderSubmitted;
}

export interface MediaGenerationResult {
  outputStoragePath: string;
  mimeType: string;
  /** Exact byte length of the object actually uploaded to Storage — never a provider-declared or separately-fetched size. */
  sizeBytes: number;
  providerRequestId: string;
  latencyMs: number;
}

export interface VideoGenerationResult extends MediaGenerationResult {
  durationSeconds: number;
}

export interface CreatorMediaProvider {
  readonly name: string;
  generateCharacterImage(req: CharacterImageRequest): Promise<MediaGenerationResult>;
  generateImageFromCharacter(req: ImageFromCharacterRequest): Promise<MediaGenerationResult>;
  generateVideoFromImage(req: VideoFromImageRequest): Promise<VideoGenerationResult>;
  /**
   * Removes a just-generated output this same provider call uploaded
   * (identified by the exact `outputStoragePath` a
   * MediaGenerationResult/VideoGenerationResult just returned) — used only
   * to compensate when persisting the DB asset row for that output fails
   * (P1 orphan-cleanup hardening). Never accepts an arbitrary bucket; each
   * implementation scopes this to its own fixed generated-output bucket.
   * Throws on a genuine deletion failure so the caller can log it
   * separately — never on "already gone" (a missing object is a no-op,
   * not an error), since the caller only ever calls this once, right after
   * an upload it just performed itself.
   */
  cleanupGeneratedOutput(storagePath: string): Promise<void>;
}

export type CaptionLanguage = "EN" | "FI" | "AR";

export interface CaptionRequest {
  platform: string;
  language: CaptionLanguage;
  tone?: string;
  objective?: string;
  businessContext?: string;
}

export interface CaptionResult {
  primary: string;
  short: string;
  cta: string;
  hashtags: string[];
  providerRequestId: string;
  latencyMs: number;
}

export interface CreatorCaptionProvider {
  readonly name: string;
  generateCaption(req: CaptionRequest): Promise<CaptionResult>;
}
