import "server-only";

import { ClaudeCaptionProvider } from "./caption-provider";
import { getRoutedCreatorMediaProvider } from "./router";
import type { CreatorMediaProvider, CreatorCaptionProvider } from "./types";

const captionProvider: CreatorCaptionProvider = new ClaudeCaptionProvider();

/**
 * Capability-based provider resolution (Phase 3). Each capability resolves
 * its own provider independently — a real image/video vendor can be added
 * later (by cost/quality/latency/region/plan) without touching caption
 * routing, and vice versa. Callers never import a provider SDK directly.
 * Media provider resolution (mock vs. fal.ai vs. a future premium provider)
 * lives in ./router.ts.
 */
export function getCreatorMediaProvider(): CreatorMediaProvider {
  return getRoutedCreatorMediaProvider();
}

export function getCreatorCaptionProvider(): CreatorCaptionProvider {
  return captionProvider;
}

export * from "./types";
export type { CreatorMediaProviderName } from "./router";
