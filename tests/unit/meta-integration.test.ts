import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Meta Graph API client — mocked fetch throughout (no live META_APP_ID/
 * META_APP_SECRET exists in CI/this environment). Proves the request/
 * response contract shape against Meta's documented API, not against a
 * live app.
 */

const originalAppId = process.env.META_APP_ID;
const originalAppSecret = process.env.META_APP_SECRET;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Meta Graph API client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.META_APP_ID = "test-app-id";
    process.env.META_APP_SECRET = "test-app-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env.META_APP_ID = originalAppId;
    process.env.META_APP_SECRET = originalAppSecret;
    vi.unstubAllGlobals();
  });

  it("isMetaConfigured reflects META_APP_ID/META_APP_SECRET presence", async () => {
    const { isMetaConfigured } = await import("@/server/integrations/meta/client");
    expect(isMetaConfigured()).toBe(true);
    delete process.env.META_APP_ID;
    expect(isMetaConfigured()).toBe(false);
  });

  it("throws MetaNotConfiguredError building an authorize URL when unconfigured", async () => {
    delete process.env.META_APP_SECRET;
    const { metaAuthorizeUrl, MetaNotConfiguredError } =
      await import("@/server/integrations/meta/client");
    expect(() => metaAuthorizeUrl("state123")).toThrow(MetaNotConfiguredError);
  });

  it("builds an authorize URL with the fixed redirect_uri and required scopes", async () => {
    const { metaAuthorizeUrl } = await import("@/server/integrations/meta/client");
    const url = new URL(metaAuthorizeUrl("state123"));
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("client_id")).toBe("test-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/v1/creator-studio/social-accounts/oauth/meta/callback",
    );
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("scope")).toContain("instagram_content_publish");
  });

  it("exchanges a code for a user token, then a long-lived token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "short-lived", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "long-lived", expires_in: 5_184_000 }));

    const { exchangeCodeForUserToken, exchangeForLongLivedToken } =
      await import("@/server/integrations/meta/client");
    const shortLived = await exchangeCodeForUserToken("auth-code-1");
    expect(shortLived.access_token).toBe("short-lived");

    const longLived = await exchangeForLongLivedToken(shortLived.access_token);
    expect(longLived.accessToken).toBe("long-lived");
    expect(longLived.expiresAt).toBeInstanceOf(Date);

    const firstCallUrl = fetchMock.mock.calls[0]![0] as string;
    expect(firstCallUrl).toContain("/oauth/access_token");
    expect(firstCallUrl).toContain("code=auth-code-1");
  });

  it("lists managed Pages with their Instagram business account, when linked", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "page-1",
            name: "My Page",
            access_token: "page-token-1",
            instagram_business_account: { id: "ig-1" },
          },
          { id: "page-2", name: "No IG Page", access_token: "page-token-2" },
        ],
      }),
    );

    const { listManagedPages } = await import("@/server/integrations/meta/client");
    const pages = await listManagedPages("user-token");
    expect(pages).toEqual([
      {
        id: "page-1",
        name: "My Page",
        accessToken: "page-token-1",
        instagramBusinessAccountId: "ig-1",
      },
      {
        id: "page-2",
        name: "No IG Page",
        accessToken: "page-token-2",
        instagramBusinessAccountId: undefined,
      },
    ]);
  });

  it("publishes a Facebook photo synchronously", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ post_id: "page-1_post-1" }));
    const { publishFacebookPhoto } = await import("@/server/integrations/meta/client");
    const result = await publishFacebookPhoto("page-1", "page-token", {
      imageUrl: "https://storage.example/img.png",
      caption: "hello",
    });
    expect(result.postId).toBe("page-1_post-1");
  });

  it("publishes Instagram media by creating a container, polling until FINISHED, then publishing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" })) // create container
      .mockResolvedValueOnce(jsonResponse({ status_code: "IN_PROGRESS" })) // poll 1
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" })) // poll 2
      .mockResolvedValueOnce(jsonResponse({ id: "ig-post-1" })); // media_publish

    vi.useFakeTimers();
    const { publishInstagramMedia } = await import("@/server/integrations/meta/client");
    const resultPromise = publishInstagramMedia("ig-1", "page-token", {
      imageUrl: "https://storage.example/img.png",
      caption: "hello #test",
      isVideo: false,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.postId).toBe("ig-post-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws MetaApiError when an Instagram media container ends in ERROR", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "ERROR" }));

    const { publishInstagramMedia, MetaApiError } =
      await import("@/server/integrations/meta/client");
    await expect(
      publishInstagramMedia("ig-1", "page-token", {
        imageUrl: "https://storage.example/img.png",
        caption: "x",
        isVideo: false,
      }),
    ).rejects.toBeInstanceOf(MetaApiError);
  });

  it("throws MetaApiError on a Graph API error response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400),
    );
    const { publishFacebookPhoto, MetaApiError } =
      await import("@/server/integrations/meta/client");
    await expect(
      publishFacebookPhoto("page-1", "bad-token", { imageUrl: "https://x/y.png", caption: "x" }),
    ).rejects.toBeInstanceOf(MetaApiError);
  });
});
