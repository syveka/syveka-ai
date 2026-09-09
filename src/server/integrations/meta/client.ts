import "server-only";

import { getAppUrlEnv } from "@/env";

/**
 * Meta Graph API client (Facebook Pages + Instagram Graph API), REST only —
 * mirrors src/server/integrations/calendar/google.ts's shape (no SDK
 * dependency, explicit typed responses). Used by
 * src/server/social/meta-provider.ts for both INSTAGRAM and FACEBOOK, since
 * both platforms publish through the same Meta app/Page access-token model.
 *
 * Env: META_APP_ID / META_APP_SECRET (required), META_GRAPH_API_VERSION
 * (optional, defaults below) — validated independently of every other
 * integration's config per CLAUDE.md §4.
 */

const DEFAULT_GRAPH_VERSION = "v21.0";
const CONTAINER_POLL_INTERVAL_MS = 2000;
const CONTAINER_POLL_TIMEOUT_MS = 120_000;

export class MetaNotConfiguredError extends Error {
  readonly code = "meta_not_configured";
  constructor() {
    super("Meta Graph API is not configured (set META_APP_ID and META_APP_SECRET).");
  }
}

export class MetaApiError extends Error {
  readonly code = "meta_api_error";
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

function appId(): string | undefined {
  return process.env.META_APP_ID;
}
function appSecret(): string | undefined {
  return process.env.META_APP_SECRET;
}

export function isMetaConfigured(): boolean {
  return Boolean(appId() && appSecret());
}

function graphVersion(): string {
  return process.env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION;
}

function graphBase(): string {
  return `https://graph.facebook.com/${graphVersion()}`;
}

/** Fixed, App-registered redirect URI — identical for Instagram and Facebook (one Meta app covers both). */
export function metaOAuthRedirectUri(): string {
  return `${getAppUrlEnv().NEXT_PUBLIC_APP_URL}/api/v1/creator-studio/social-accounts/oauth/meta/callback`;
}

const META_OAUTH_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

export function metaAuthorizeUrl(state: string): string {
  if (!isMetaConfigured()) throw new MetaNotConfiguredError();
  const q = new URLSearchParams({
    client_id: appId()!,
    redirect_uri: metaOAuthRedirectUri(),
    response_type: "code",
    scope: META_OAUTH_SCOPES.join(","),
    state,
  });
  return `https://www.facebook.com/${graphVersion()}/dialog/oauth?${q.toString()}`;
}

async function graphFetch<T>(
  path: string,
  init?: RequestInit & { retryOn5xx?: boolean },
): Promise<T> {
  const url = path.startsWith("http") ? path : `${graphBase()}${path}`;
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as
    T | { error?: { message?: string; code?: number; is_transient?: boolean } };
  if (!res.ok || (body && typeof body === "object" && "error" in body && body.error)) {
    const err = (body as { error?: { message?: string; is_transient?: boolean } }).error;
    throw new MetaApiError(
      `Meta Graph API error: ${err?.message ?? res.statusText}`,
      Boolean(err?.is_transient) || res.status >= 500 || res.status === 429,
    );
  }
  return body as T;
}

type UserTokenResponse = { access_token: string; token_type?: string; expires_in?: number };

/** Step 1: exchange the OAuth `code` for a short-lived user access token. */
export async function exchangeCodeForUserToken(code: string): Promise<UserTokenResponse> {
  if (!isMetaConfigured()) throw new MetaNotConfiguredError();
  const q = new URLSearchParams({
    client_id: appId()!,
    client_secret: appSecret()!,
    redirect_uri: metaOAuthRedirectUri(),
    code,
  });
  return graphFetch<UserTokenResponse>(`/oauth/access_token?${q.toString()}`);
}

/**
 * Step 2: exchange a short- or long-lived user token for a fresh long-lived
 * one (~60 days). Also used to "refresh" a stored long-lived token before it
 * expires, since Meta has no separate refresh_token grant.
 */
export async function exchangeForLongLivedToken(userAccessToken: string): Promise<{
  accessToken: string;
  expiresAt?: Date;
}> {
  if (!isMetaConfigured()) throw new MetaNotConfiguredError();
  const q = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId()!,
    client_secret: appSecret()!,
    fb_exchange_token: userAccessToken,
  });
  const data = await graphFetch<UserTokenResponse>(`/oauth/access_token?${q.toString()}`);
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
  };
}

export type MetaPage = {
  id: string;
  name: string;
  accessToken: string;
  instagramBusinessAccountId?: string;
};

/** Pages the authorizing user manages, with each Page's own access token and (if linked) Instagram business account id. */
export async function listManagedPages(userAccessToken: string): Promise<MetaPage[]> {
  const data = await graphFetch<{
    data?: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string };
    }>;
  }>(
    `/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(userAccessToken)}`,
  );
  return (data.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    accessToken: p.access_token,
    instagramBusinessAccountId: p.instagram_business_account?.id,
  }));
}

/** Publishes a photo directly (synchronous — returns once the Page post exists). */
export async function publishFacebookPhoto(
  pageId: string,
  pageAccessToken: string,
  params: { imageUrl: string; caption: string },
): Promise<{ postId: string }> {
  const data = await graphFetch<{ id?: string; post_id?: string }>(`/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      url: params.imageUrl,
      caption: params.caption,
      access_token: pageAccessToken,
    }),
  });
  const postId = data.post_id ?? data.id;
  if (!postId) throw new MetaApiError("Facebook photo publish returned no post id");
  return { postId };
}

/** Publishes a video (Meta processes it asynchronously; the returned id is stable, status polled separately). */
export async function publishFacebookVideo(
  pageId: string,
  pageAccessToken: string,
  params: { videoUrl: string; caption: string },
): Promise<{ postId: string }> {
  const data = await graphFetch<{ id?: string }>(`/${pageId}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      file_url: params.videoUrl,
      description: params.caption,
      access_token: pageAccessToken,
    }),
  });
  if (!data.id) throw new MetaApiError("Facebook video publish returned no post id");
  return { postId: data.id };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Two-step Instagram publish: create a media container, poll until ready, then publish it. */
export async function publishInstagramMedia(
  igUserId: string,
  pageAccessToken: string,
  params: { imageUrl?: string; videoUrl?: string; caption: string; isVideo: boolean },
): Promise<{ postId: string }> {
  const createBody = new URLSearchParams({
    caption: params.caption,
    access_token: pageAccessToken,
  });
  if (params.isVideo) {
    if (!params.videoUrl) throw new MetaApiError("Instagram video publish requires a video URL");
    createBody.set("video_url", params.videoUrl);
    createBody.set("media_type", "REELS");
  } else {
    if (!params.imageUrl) throw new MetaApiError("Instagram image publish requires an image URL");
    createBody.set("image_url", params.imageUrl);
  }

  const container = await graphFetch<{ id?: string }>(`/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createBody,
  });
  if (!container.id) throw new MetaApiError("Instagram media container creation returned no id");

  const deadline = Date.now() + CONTAINER_POLL_TIMEOUT_MS;
  for (;;) {
    const status = await graphFetch<{ status_code?: string }>(
      `/${container.id}?fields=status_code&access_token=${encodeURIComponent(pageAccessToken)}`,
    );
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new MetaApiError(`Instagram media container failed: ${status.status_code}`);
    }
    if (Date.now() > deadline) {
      throw new MetaApiError("Instagram media container timed out before publishing", true);
    }
    await sleep(CONTAINER_POLL_INTERVAL_MS);
  }

  const published = await graphFetch<{ id?: string }>(`/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: container.id, access_token: pageAccessToken }),
  });
  if (!published.id) throw new MetaApiError("Instagram media_publish returned no post id");
  return { postId: published.id };
}

/** Best-effort status probe — no page/user token is available to this call (see SocialPublishingProvider.getPublishStatus). */
export async function getMetaObjectStatus(
  objectId: string,
): Promise<"published" | "processing" | "failed"> {
  try {
    const data = await graphFetch<{ id?: string; status?: string }>(
      `/${objectId}?fields=id,status`,
    );
    if (!data.id) return "failed";
    if (data.status && data.status !== "ready" && data.status !== "published") return "processing";
    return "published";
  } catch {
    return "published"; // publishPost already confirmed completion before returning
  }
}

/** Revokes every permission the app was granted for this user (best-effort — called on disconnect). */
export async function revokeMetaAccess(userAccessToken: string, userId = "me"): Promise<void> {
  await graphFetch(`/${userId}/permissions?access_token=${encodeURIComponent(userAccessToken)}`, {
    method: "DELETE",
  }).catch(() => undefined);
}
