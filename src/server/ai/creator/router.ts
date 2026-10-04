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
 * No real media provider can run. Thrown before any credit is reserved: every
 * generation resolves its provider first, since the credit cost depends on it.
 * The message is shown to customers, so it names no configuration.
 */
export class CreatorMediaProviderUnavailableError extends Error {
  readonly code = "media_provider_not_configured";

  constructor() {
    super("Media generation is temporarily unavailable.");
    this.name = "CreatorMediaProviderUnavailableError";
  }
}

/**
 * Fails closed in production: a missing FAL_API_KEY must never silently serve
 * mock media (which still costs credits) to real customers. An explicit
 * CREATOR_MEDIA_PROVIDER=mock pin is still honored as a deliberate operator
 * choice, like CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER=1. A `fal` pin without a
 * key fails closed everywhere instead of failing after credits are reserved.
 */
function resolveMediaProviderName(): CreatorMediaProviderName {
  const pinned = process.env.CREATOR_MEDIA_PROVIDER as CreatorMediaProviderName | undefined;
  if (pinned === "mock") return "mock";
  if (isFalConfigured()) return "fal";
  if (pinned === "fal" || process.env.NODE_ENV === "production") {
    throw new CreatorMediaProviderUnavailableError();
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
