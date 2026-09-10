import "server-only";

import { randomUUID } from "node:crypto";
import type {
  CreatorMediaProvider,
  CharacterImageRequest,
  ImageFromCharacterRequest,
  VideoFromImageRequest,
  MediaGenerationResult,
  VideoGenerationResult,
} from "./types";

/**
 * Deterministic, no-network mock media provider. No real image/video
 * generation vendor is wired into this v1 release (Phase 3/26: no paid
 * external calls in CI, and adding a new AI vendor integration is outside
 * this mission's approved scope) — this is the sole CreatorMediaProvider
 * today. It returns a synthetic storage path; it does not itself write any
 * bytes to Supabase Storage, so the calling service (creator-generations.ts)
 * is responsible for persisting a real (or, here, placeholder) object at
 * that path before marking a generation COMPLETED.
 */
export class MockCreatorMediaProvider implements CreatorMediaProvider {
  readonly name = "mock";

  async generateCharacterImage(req: CharacterImageRequest): Promise<MediaGenerationResult> {
    return this.fakeMedia(req.aspectRatio, "image");
  }

  async generateImageFromCharacter(req: ImageFromCharacterRequest): Promise<MediaGenerationResult> {
    return this.fakeMedia(req.aspectRatio, "image");
  }

  async generateVideoFromImage(req: VideoFromImageRequest): Promise<VideoGenerationResult> {
    const base = await this.fakeMedia(req.aspectRatio, "video");
    return { ...base, durationSeconds: req.durationSeconds ?? 5 };
  }

  private async fakeMedia(
    _aspectRatio: string,
    kind: "image" | "video",
  ): Promise<MediaGenerationResult> {
    const latencyMs = 150 + Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ext = kind === "video" ? "mp4" : "png";
    return {
      outputStoragePath: `mock/${kind}/${randomUUID()}.${ext}`,
      mimeType: kind === "video" ? "video/mp4" : "image/png",
      // No real bytes are written for the mock provider, so there is no real
      // size to report — see the class doc comment above.
      sizeBytes: 0,
      providerRequestId: `mock_${randomUUID()}`,
      latencyMs,
    };
  }

  async cleanupGeneratedOutput(): Promise<void> {
    // No real bytes are ever written for the mock provider, so there is
    // never anything real to clean up — see the class doc comment above.
  }
}
