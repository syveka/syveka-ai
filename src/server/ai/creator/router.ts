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

function resolveMediaProviderName(): CreatorMediaProviderName {
  const pinned = process.env.CREATOR_MEDIA_PROVIDER as CreatorMediaProviderName | undefined;
  if (pinned && pinned in PROVIDERS) return pinned;
  return isFalConfigured() ? "fal" : "mock";
}

/**
 * True when production would serve mock media only because FAL_API_KEY is
 * missing, rather than an operator deliberately pinning
 * CREATOR_MEDIA_PROVIDER=mock. Mock generations still reserve credits, so
 * generation must fail closed in that state instead of charging for fake media.
 */
export function isUnconfiguredMockInProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.CREATOR_MEDIA_PROVIDER !== "mock" &&
    resolveMediaProviderName() === "mock"
  );
}

export function getRoutedCreatorMediaProvider(): CreatorMediaProvider {
  const name = resolveMediaProviderName();
  if (!mediaProviderSingleton || resolvedProviderName !== name) {
    mediaProviderSingleton = PROVIDERS[name]();
    resolvedProviderName = name;
  }
  return mediaProviderSingleton;
}
