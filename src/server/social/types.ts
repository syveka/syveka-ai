/**
 * SocialPublishingProvider (Phase 11): a provider-agnostic publishing
 * contract. Each SocialPlatform resolves to exactly one adapter via
 * getSocialPublishingProvider() (src/server/social/index.ts) — callers
 * never import a platform SDK directly.
 */

export type SocialMediaType = "image" | "video";

export interface SocialAccountConnection {
  externalAccountId: string;
  displayName: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  tokenExpiresAt?: Date;
}

export interface SocialPublishRequest {
  caption: string;
  hashtags: string[];
  assetStoragePaths: string[];
  /**
   * Fetchable (signed, time-limited) URL for each entry in
   * assetStoragePaths, same order/length — real platform APIs (Meta's
   * included) fetch media by URL server-to-server rather than accepting an
   * upload body, and never get direct access to private storage buckets.
   * Populated by the publishing engine (src/server/services/creator-publishing.ts),
   * which alone knows which bucket each asset lives in; providers never sign
   * storage URLs themselves. The mock provider ignores this field.
   */
  assetUrls: string[];
  mediaType: SocialMediaType;
}

export interface SocialPublishResult {
  externalPostId: string;
  providerRequestId: string;
}

export type SocialPublishStatus = "processing" | "published" | "failed";

/** Thrown by a real-platform adapter that has no working API integration yet. */
export class SocialProviderNotImplementedError extends Error {
  readonly code = "social_provider_not_implemented";
  constructor(platform: string, detail: string) {
    super(`${platform} publishing is not implemented yet: ${detail}`);
  }
}

export interface SocialPublishingProvider {
  readonly platform: string;
  /** "full": end-to-end real integration. "blocked": adapter exists, real API calls are not implemented (Phase 11). */
  readonly capability: "full" | "blocked";
  isConfigured(): boolean;
  connectAccount(authCode: string): Promise<SocialAccountConnection>;
  refreshConnection(refreshToken: string): Promise<SocialAccountConnection>;
  publishPost(
    connection: { accessToken: string; externalAccountId: string },
    req: SocialPublishRequest,
  ): Promise<SocialPublishResult>;
  getPublishStatus(externalPostId: string): Promise<SocialPublishStatus>;
  revokeConnection(accessToken: string): Promise<void>;
}
