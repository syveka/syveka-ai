import "server-only";

import { MockCreatorMediaProvider } from "./mock-provider";
import { ClaudeCaptionProvider } from "./caption-provider";
import type { CreatorMediaProvider, CreatorCaptionProvider } from "./types";

const mediaProvider: CreatorMediaProvider = new MockCreatorMediaProvider();
const captionProvider: CreatorCaptionProvider = new ClaudeCaptionProvider();

/**
 * Capability-based provider resolution (Phase 3). Each capability resolves
 * its own provider independently — a real image/video vendor can be added
 * later (by cost/quality/latency/region/plan) without touching caption
 * routing, and vice versa. Callers never import a provider SDK directly.
 */
export function getCreatorMediaProvider(): CreatorMediaProvider {
  return mediaProvider;
}

export function getCreatorCaptionProvider(): CreatorCaptionProvider {
  return captionProvider;
}

export * from "./types";
