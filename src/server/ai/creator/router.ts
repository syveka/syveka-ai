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
 * Production never serves mock media (which still costs credits): a missing
 * FAL_API_KEY fails closed, and so does a CREATOR_MEDIA_PROVIDER=mock pin. A
 * stray pin then surfaces as an error instead of silently serving placeholders
 * or being silently ignored. Outside production the mock pin and the mock
 * fallback still work. A `fal` pin without a key fails closed everywhere
 * instead of failing after credits are reserved.
 */
function resolveMediaProviderName(): CreatorMediaProviderName {
  const pinned = process.env.CREATOR_MEDIA_PROVIDER as CreatorMediaProviderName | undefined;
  const production = process.env.NODE_ENV === "production";
  if (pinned === "mock") {
    if (production) throw new CreatorMediaProviderUnavailableError();
    return "mock";
  }
  if (isFalConfigured()) return "fal";
  if (pinned === "fal" || production) throw new CreatorMediaProviderUnavailableError();
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
