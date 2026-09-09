import "server-only";

import type {
  SocialPublishingProvider,
  SocialAccountConnection,
  SocialPublishRequest,
  SocialPublishResult,
  SocialPublishStatus,
} from "./types";
import { SocialProviderNotImplementedError } from "./types";

/**
 * Shared base for a real-platform adapter that is not safely completable in
 * this mission (Phase 11: "If one provider/API cannot be completed safely
 * in this mission, implement its adapter interface and mark the real
 * capability clearly as blocked."). Each subclass documents exactly what is
 * missing (app registration, API review, credentials) so wiring in the real
 * integration later is a scoped, known task — not a guess.
 */
export abstract class BlockedSocialPublishingProvider implements SocialPublishingProvider {
  abstract readonly platform: string;
  abstract readonly blockedReason: string;
  readonly capability = "blocked" as const;

  isConfigured(): boolean {
    return false;
  }

  async connectAccount(_authCode: string): Promise<SocialAccountConnection> {
    throw new SocialProviderNotImplementedError(this.platform, this.blockedReason);
  }

  async refreshConnection(_refreshToken: string): Promise<SocialAccountConnection> {
    throw new SocialProviderNotImplementedError(this.platform, this.blockedReason);
  }

  async publishPost(
    _connection: { accessToken: string; externalAccountId: string },
    _req: SocialPublishRequest,
  ): Promise<SocialPublishResult> {
    throw new SocialProviderNotImplementedError(this.platform, this.blockedReason);
  }

  async getPublishStatus(_externalPostId: string): Promise<SocialPublishStatus> {
    throw new SocialProviderNotImplementedError(this.platform, this.blockedReason);
  }

  async revokeConnection(_accessToken: string): Promise<void> {
    throw new SocialProviderNotImplementedError(this.platform, this.blockedReason);
  }
}

export class InstagramPublishingProvider extends BlockedSocialPublishingProvider {
  readonly platform = "INSTAGRAM";
  readonly blockedReason =
    "requires a Meta Business app with the Instagram Graph API's content_publish " +
    "permission (App Review) plus a connected Instagram professional account; " +
    "no Meta app is registered for this deployment yet.";
}

export class FacebookPublishingProvider extends BlockedSocialPublishingProvider {
  readonly platform = "FACEBOOK";
  readonly blockedReason =
    "requires a Meta Business app with the Pages API's pages_manage_posts " +
    "permission (App Review) plus a connected Facebook Page; no Meta app is " +
    "registered for this deployment yet.";
}

export class TikTokPublishingProvider extends BlockedSocialPublishingProvider {
  readonly platform = "TIKTOK";
  readonly blockedReason =
    "requires a TikTok for Developers app approved for the Content Posting API " +
    "(video.publish scope); no TikTok app is registered for this deployment yet.";
}

export class YouTubePublishingProvider extends BlockedSocialPublishingProvider {
  readonly platform = "YOUTUBE";
  readonly blockedReason =
    "requires a Google Cloud project with the YouTube Data API v3 enabled, " +
    "OAuth consent screen verification, and a quota extension for uploads; " +
    "no Google Cloud project is registered for this deployment yet.";
}
