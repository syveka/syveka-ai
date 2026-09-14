import "server-only";

import { MockCreatorMediaProvider } from "./mock-provider";
import { FalCreatorMediaProvider } from "./fal-provider";
import { isFalConfigured } from "@/server/integrations/fal";
import type { CreatorMediaProvider } from "./types";

/**
 * Capability-based media provider routing (Phase 3), mirroring the shape of
 * src/server/ai/router.ts's routeModel(): a name -> instance map plus a
 * resolver function, so adding a premium provider later (e.g. Veo) is one
 * new case here, not a rewrite of any calling code. `CREATOR_MEDIA_PROVIDER`
 * lets an operator pin a specific provider (e.g. for a customer plan tier)
 * instead of relying on config-presence auto-detection.
 */
export type CreatorMediaProviderName = "mock" | "fal"; // future: "veo"

const PROVIDERS: Record<CreatorMediaProviderName, () => CreatorMediaProvider> = {
  mock: () => new MockCreatorMediaProvider(),
  fal: () => new FalCreatorMediaProvider(),
};

let mediaProviderSingleton: CreatorMediaProvider | null = null;
let resolvedProviderName: CreatorMediaProviderName | null = null;

/**
 * Fail closed in production: an explicit `CREATOR_MEDIA_PROVIDER=mock` pin is
 * still honored (a deliberate operator choice, same escape valve
 * src/server/social/index.ts's CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER=1
 * provides), but the *implicit* fallback below — silently serving mock media
 * when FAL_API_KEY is simply missing/misconfigured — must never happen in
 * production. Without this, a missing key would silently generate fake
 * images/video for a real customer while still charging real credits,
 * rather than surfacing a clear, fixable configuration error.
 */
function resolveMediaProviderName(): CreatorMediaProviderName {
  const pinned = process.env.CREATOR_MEDIA_PROVIDER as CreatorMediaProviderName | undefined;
  if (pinned && pinned in PROVIDERS) return pinned;
  if (isFalConfigured()) return "fal";
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Creator Studio media generation is not configured (FAL_API_KEY is unset) and cannot " +
        "silently fall back to the mock provider in production. Set FAL_API_KEY, or explicitly " +
        "pin CREATOR_MEDIA_PROVIDER=mock if serving mock media in production is intentional.",
    );
  }
  return "mock";
}

export function getRoutedCreatorMediaProvider(): CreatorMediaProvider {
  const name = resolveMediaProviderName();
  if (!mediaProviderSingleton || resolvedProviderName !== name) {
    mediaProviderSingleton = PROVIDERS[name]();
    resolvedProviderName = name;
  }
  return mediaProviderSingleton;
}
