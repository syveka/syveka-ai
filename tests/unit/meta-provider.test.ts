import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MetaClientModule from "@/server/integrations/meta/client";

const {
  isMetaConfiguredMock,
  exchangeCodeForUserTokenMock,
  exchangeForLongLivedTokenMock,
  listManagedPagesMock,
  publishFacebookPhotoMock,
  publishFacebookVideoMock,
  publishInstagramMediaMock,
  getMetaObjectStatusMock,
  revokeMetaAccessMock,
} = vi.hoisted(() => ({
  isMetaConfiguredMock: vi.fn(() => true),
  exchangeCodeForUserTokenMock: vi.fn(async () => ({ access_token: "short-lived" })),
  exchangeForLongLivedTokenMock: vi.fn(async () => ({
    accessToken: "long-lived",
    expiresAt: new Date("2026-11-01T00:00:00Z"),
  })),
  listManagedPagesMock: vi.fn(),
  publishFacebookPhotoMock: vi.fn(async () => ({ postId: "fb-post-1" })),
  publishFacebookVideoMock: vi.fn(async () => ({ postId: "fb-video-1" })),
  publishInstagramMediaMock: vi.fn(async () => ({ postId: "ig-post-1" })),
  getMetaObjectStatusMock: vi.fn(async () => "published" as const),
  revokeMetaAccessMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/integrations/meta/client", async () => {
  const actual = await vi.importActual<typeof MetaClientModule>(
    "@/server/integrations/meta/client",
  );
  return {
    ...actual,
    isMetaConfigured: isMetaConfiguredMock,
    exchangeCodeForUserToken: exchangeCodeForUserTokenMock,
    exchangeForLongLivedToken: exchangeForLongLivedTokenMock,
    listManagedPages: listManagedPagesMock,
    publishFacebookPhoto: publishFacebookPhotoMock,
    publishFacebookVideo: publishFacebookVideoMock,
    publishInstagramMedia: publishInstagramMediaMock,
    getMetaObjectStatus: getMetaObjectStatusMock,
    revokeMetaAccess: revokeMetaAccessMock,
  };
});

import {
  InstagramPublishingProvider,
  FacebookPublishingProvider,
} from "@/server/social/meta-provider";

const PAGE_WITH_IG = {
  id: "page-1",
  name: "My Page",
  accessToken: "page-token-1",
  instagramBusinessAccountId: "ig-1",
};
const PAGE_WITHOUT_IG = { id: "page-2", name: "Other Page", accessToken: "page-token-2" };

describe("MetaPublishingProviderBase (Instagram/Facebook)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMetaConfiguredMock.mockReturnValue(true);
  });

  it("Instagram connectAccount picks the first Page with a linked Instagram business account", async () => {
    listManagedPagesMock.mockResolvedValue([PAGE_WITHOUT_IG, PAGE_WITH_IG]);
    const provider = new InstagramPublishingProvider();
    const connection = await provider.connectAccount("oauth-code");

    expect(connection.externalAccountId).toBe("ig-1");
    expect(connection.accessToken).toBe("page-token-1");
    expect(connection.refreshToken).toBe("long-lived");
    expect(exchangeCodeForUserTokenMock).toHaveBeenCalledWith("oauth-code");
  });

  it("Instagram connectAccount throws when no Page has a linked Instagram account", async () => {
    listManagedPagesMock.mockResolvedValue([PAGE_WITHOUT_IG]);
    const provider = new InstagramPublishingProvider();
    await expect(provider.connectAccount("oauth-code")).rejects.toThrow();
  });

  it("Facebook connectAccount picks the first managed Page", async () => {
    listManagedPagesMock.mockResolvedValue([PAGE_WITHOUT_IG, PAGE_WITH_IG]);
    const provider = new FacebookPublishingProvider();
    const connection = await provider.connectAccount("oauth-code");
    expect(connection.externalAccountId).toBe("page-2");
  });

  it("Instagram publishPost appends hashtags to the caption and publishes an image", async () => {
    const provider = new InstagramPublishingProvider();
    const result = await provider.publishPost(
      { accessToken: "page-token-1", externalAccountId: "ig-1" },
      {
        caption: "hello world",
        hashtags: ["#a", "#b"],
        assetStoragePaths: ["org/x.png"],
        assetUrls: ["https://storage.example/signed/x.png"],
        mediaType: "image",
      },
    );
    expect(result.externalPostId).toBe("ig-post-1");
    expect(publishInstagramMediaMock).toHaveBeenCalledWith(
      "ig-1",
      "page-token-1",
      expect.objectContaining({
        imageUrl: "https://storage.example/signed/x.png",
        caption: "hello world\n\n#a #b",
        isVideo: false,
      }),
    );
  });

  it("Facebook publishPost routes video assets to the video endpoint", async () => {
    const provider = new FacebookPublishingProvider();
    const result = await provider.publishPost(
      { accessToken: "page-token-1", externalAccountId: "page-1" },
      {
        caption: "a video",
        hashtags: [],
        assetStoragePaths: ["org/x.mp4"],
        assetUrls: ["https://storage.example/signed/x.mp4"],
        mediaType: "video",
      },
    );
    expect(result.externalPostId).toBe("fb-video-1");
    expect(publishFacebookVideoMock).toHaveBeenCalledWith("page-1", "page-token-1", {
      videoUrl: "https://storage.example/signed/x.mp4",
      caption: "a video",
    });
    expect(publishFacebookPhotoMock).not.toHaveBeenCalled();
  });

  it("refreshConnection re-derives a Page token from the stored long-lived user token", async () => {
    listManagedPagesMock.mockResolvedValue([PAGE_WITH_IG]);
    const provider = new FacebookPublishingProvider();
    const refreshed = await provider.refreshConnection("stored-long-lived-user-token");
    expect(exchangeForLongLivedTokenMock).toHaveBeenCalledWith("stored-long-lived-user-token");
    expect(refreshed.accessToken).toBe("page-token-1");
  });

  it("isConfigured reflects isMetaConfigured()", async () => {
    isMetaConfiguredMock.mockReturnValue(false);
    const provider = new InstagramPublishingProvider();
    expect(provider.isConfigured()).toBe(false);
  });
});
