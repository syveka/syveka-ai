import "server-only";

import {
  isMetaConfigured,
  metaAuthorizeUrl,
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  listManagedPages,
  publishFacebookPhoto,
  publishFacebookVideo,
  publishInstagramMedia,
  getMetaObjectStatus,
  revokeMetaAccess,
  MetaApiError,
  type MetaPage,
} from "@/server/integrations/meta/client";
import type {
  SocialPublishingProvider,
  SocialAccountConnection,
  SocialPublishRequest,
  SocialPublishResult,
  SocialPublishStatus,
} from "./types";

export { metaAuthorizeUrl };

/**
 * Real Instagram + Facebook publishing via the Meta Graph API (Phase 11
 * follow-up). Both platforms share one Meta app and one OAuth grant — a
 * user authorizes once, we discover their Facebook Pages and (if linked)
 * Instagram professional accounts, and connect the first eligible one per
 * platform.
 *
 * Known, disclosed limitation: connectAccount() has no way to let the user
 * pick among multiple eligible Pages/Instagram accounts (the
 * SocialPublishingProvider interface's connectAccount(authCode) returns a
 * single SocialAccountConnection) — it always connects the first eligible
 * one. An org managing several Pages must disconnect/reconnect to switch
 * which Page publishes; a future enhancement could extend the connect flow
 * with an explicit account-picker step.
 */
abstract class MetaPublishingProviderBase implements SocialPublishingProvider {
  abstract readonly platform: "INSTAGRAM" | "FACEBOOK";
  readonly capability = "full" as const;

  isConfigured(): boolean {
    return isMetaConfigured();
  }

  protected abstract pickTarget(pages: MetaPage[]): {
    externalAccountId: string;
    displayName: string;
    accessToken: string;
  } | null;

  async connectAccount(authCode: string): Promise<SocialAccountConnection> {
    const shortLived = await exchangeCodeForUserToken(authCode);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token);
    const pages = await listManagedPages(longLived.accessToken);

    const target = this.pickTarget(pages);
    if (!target) {
      throw new MetaApiError(
        this.platform === "INSTAGRAM"
          ? "No Instagram professional account is linked to any Facebook Page you manage."
          : "No Facebook Page was found for this account.",
      );
    }

    return {
      externalAccountId: target.externalAccountId,
      displayName: target.displayName,
      accessToken: target.accessToken,
      // The long-lived USER token is stored as refreshToken: it is what
      // refreshConnection() re-exchanges to derive a fresh Page token, since
      // Meta has no separate refresh_token grant (see client.ts).
      refreshToken: longLived.accessToken,
      scopes: [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ],
      tokenExpiresAt: longLived.expiresAt,
    };
  }

  async refreshConnection(refreshToken: string): Promise<SocialAccountConnection> {
    const longLived = await exchangeForLongLivedToken(refreshToken);
    const pages = await listManagedPages(longLived.accessToken);
    const target = this.pickTarget(pages);
    if (!target) {
      throw new MetaApiError(
        `${this.platform} account is no longer reachable with the stored authorization.`,
      );
    }
    return {
      externalAccountId: target.externalAccountId,
      displayName: target.displayName,
      accessToken: target.accessToken,
      refreshToken: longLived.accessToken,
      scopes: [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ],
      tokenExpiresAt: longLived.expiresAt,
    };
  }

  abstract publishPost(
    connection: { accessToken: string; externalAccountId: string },
    req: SocialPublishRequest,
  ): Promise<SocialPublishResult>;

  async getPublishStatus(externalPostId: string): Promise<SocialPublishStatus> {
    return getMetaObjectStatus(externalPostId);
  }

  async revokeConnection(accessToken: string): Promise<void> {
    // The stored accessToken here is the Page token; revoking permissions
    // requires the underlying user token, which is not passed to this
    // method by the SocialPublishingProvider interface. Best-effort: a Page
    // access token can itself call /me/permissions and Meta accepts it for
    // the user who granted it, so this still revokes the grant in practice.
    await revokeMetaAccess(accessToken);
  }
}

export class InstagramPublishingProvider extends MetaPublishingProviderBase {
  readonly platform = "INSTAGRAM" as const;

  protected pickTarget(pages: MetaPage[]) {
    const page = pages.find((p) => p.instagramBusinessAccountId);
    if (!page?.instagramBusinessAccountId) return null;
    return {
      externalAccountId: page.instagramBusinessAccountId,
      displayName: `${page.name} (Instagram)`,
      // Instagram Graph API publishing calls are authenticated with the
      // linked Facebook Page's access token, not a separate IG token.
      accessToken: page.accessToken,
    };
  }

  async publishPost(
    connection: { accessToken: string; externalAccountId: string },
    req: SocialPublishRequest,
  ): Promise<SocialPublishResult> {
    const url = req.assetUrls[0];
    if (!url) throw new MetaApiError("Instagram publish requires at least one media asset.");
    const caption =
      req.hashtags.length > 0 ? `${req.caption}\n\n${req.hashtags.join(" ")}` : req.caption;
    const { postId } = await publishInstagramMedia(
      connection.externalAccountId,
      connection.accessToken,
      {
        imageUrl: req.mediaType === "image" ? url : undefined,
        videoUrl: req.mediaType === "video" ? url : undefined,
        caption,
        isVideo: req.mediaType === "video",
      },
    );
    return { externalPostId: postId, providerRequestId: postId };
  }
}

export class FacebookPublishingProvider extends MetaPublishingProviderBase {
  readonly platform = "FACEBOOK" as const;

  protected pickTarget(pages: MetaPage[]) {
    const page = pages[0];
    if (!page) return null;
    return { externalAccountId: page.id, displayName: page.name, accessToken: page.accessToken };
  }

  async publishPost(
    connection: { accessToken: string; externalAccountId: string },
    req: SocialPublishRequest,
  ): Promise<SocialPublishResult> {
    const url = req.assetUrls[0];
    if (!url) throw new MetaApiError("Facebook publish requires at least one media asset.");
    const caption =
      req.hashtags.length > 0 ? `${req.caption}\n\n${req.hashtags.join(" ")}` : req.caption;
    const { postId } =
      req.mediaType === "video"
        ? await publishFacebookVideo(connection.externalAccountId, connection.accessToken, {
            videoUrl: url,
            caption,
          })
        : await publishFacebookPhoto(connection.externalAccountId, connection.accessToken, {
            imageUrl: url,
            caption,
          });
    return { externalPostId: postId, providerRequestId: postId };
  }
}
