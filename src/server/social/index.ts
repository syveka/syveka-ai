import "server-only";

import type { SocialPlatform } from "@prisma/client";
import { createMockSocialProvider } from "./mock";
import { TikTokPublishingProvider, YouTubePublishingProvider } from "./blocked-adapter";
import {
  InstagramPublishingProvider as MetaInstagramProvider,
  FacebookPublishingProvider as MetaFacebookProvider,
} from "./meta-provider";
import type { SocialPublishingProvider } from "./types";

// Instagram/Facebook: a real Meta Graph API adapter, gated on
// META_APP_ID/META_APP_SECRET being configured (isConfigured() below routes
// to mock otherwise — see mockAllowed()). TikTok/YouTube remain blocked:
// their real APIs are explicitly out of scope for this pass (per product
// direction) — only their interfaces are preserved for a future mission.
const REAL_ADAPTERS: Record<SocialPlatform, SocialPublishingProvider> = {
  INSTAGRAM: new MetaInstagramProvider(),
  FACEBOOK: new MetaFacebookProvider(),
  TIKTOK: new TikTokPublishingProvider(),
  YOUTUBE: new YouTubePublishingProvider(),
};

const MOCK_ADAPTERS: Record<SocialPlatform, SocialPublishingProvider> = {
  INSTAGRAM: createMockSocialProvider("INSTAGRAM"),
  FACEBOOK: createMockSocialProvider("FACEBOOK"),
  TIKTOK: createMockSocialProvider("TIKTOK"),
  YOUTUBE: createMockSocialProvider("YOUTUBE"),
};

function mockAllowed(): boolean {
  return (
    process.env.CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER === "1" || process.env.NODE_ENV !== "production"
  );
}

/**
 * Resolve the SocialPublishingProvider for a platform (Phase 11). Real
 * adapters are always preferred when configured — Instagram/Facebook route
 * to the real Meta Graph API adapter once META_APP_ID/META_APP_SECRET are
 * set (see meta-provider.ts); TikTok/YouTube still report isConfigured()
 * === false (see blocked-adapter.ts). Whenever a real adapter isn't
 * configured this falls through to the mock provider outside production,
 * and throws in production unless CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER=1 is
 * explicitly set (fail closed rather than silently no-op-publishing).
 */
export function getSocialPublishingProvider(platform: SocialPlatform): SocialPublishingProvider {
  const real = REAL_ADAPTERS[platform];
  if (real.isConfigured()) return real;
  if (mockAllowed()) return MOCK_ADAPTERS[platform];
  throw new Error(
    `No configured social publishing provider for ${platform} and mock providers are disabled in production.`,
  );
}

export function listSocialPlatformCapabilities(): Array<{
  platform: SocialPlatform;
  capability: "full" | "blocked";
  configured: boolean;
}> {
  return (Object.keys(REAL_ADAPTERS) as SocialPlatform[]).map((platform) => ({
    platform,
    capability: REAL_ADAPTERS[platform].isConfigured() ? "full" : "blocked",
    configured: REAL_ADAPTERS[platform].isConfigured(),
  }));
}

export * from "./types";
