import { describe, expect, it } from "vitest";
import { createMockSocialProvider } from "@/server/social/mock";
import {
  InstagramPublishingProvider,
  FacebookPublishingProvider,
  TikTokPublishingProvider,
  YouTubePublishingProvider,
} from "@/server/social/blocked-adapter";
import { SocialProviderNotImplementedError } from "@/server/social/types";

describe("mock social publishing provider", () => {
  it("exercises the whole connect -> publish -> status -> revoke pipeline without any network call", async () => {
    const provider = createMockSocialProvider("INSTAGRAM");
    expect(provider.capability).toBe("full");
    expect(provider.isConfigured()).toBe(true);

    const connection = await provider.connectAccount("auth-code-1");
    expect(connection.accessToken).toBeTruthy();
    expect(connection.externalAccountId).toContain("instagram");

    const result = await provider.publishPost(
      { accessToken: connection.accessToken, externalAccountId: connection.externalAccountId },
      {
        caption: "hello",
        hashtags: ["#a"],
        assetStoragePaths: ["a.png"],
        assetUrls: ["https://storage.example/a.png"],
        mediaType: "image",
      },
    );
    expect(result.externalPostId).toBeTruthy();

    const status = await provider.getPublishStatus(result.externalPostId);
    expect(status).toBe("published");

    await expect(provider.revokeConnection(connection.accessToken)).resolves.toBeUndefined();
  });

  it("rejects publishing with a missing access token", async () => {
    const provider = createMockSocialProvider("TIKTOK");
    await expect(
      provider.publishPost(
        { accessToken: "", externalAccountId: "x" },
        { caption: "", hashtags: [], assetStoragePaths: [], assetUrls: [], mediaType: "image" },
      ),
    ).rejects.toThrow();
  });
});

describe("blocked real-platform adapters (Phase 11)", () => {
  const adapters = [
    new InstagramPublishingProvider(),
    new FacebookPublishingProvider(),
    new TikTokPublishingProvider(),
    new YouTubePublishingProvider(),
  ];

  it("every adapter reports capability 'blocked' and isConfigured() false", () => {
    for (const adapter of adapters) {
      expect(adapter.capability).toBe("blocked");
      expect(adapter.isConfigured()).toBe(false);
    }
  });

  it("every adapter throws SocialProviderNotImplementedError rather than pretending to succeed", async () => {
    for (const adapter of adapters) {
      await expect(adapter.connectAccount("code")).rejects.toBeInstanceOf(
        SocialProviderNotImplementedError,
      );
      await expect(
        adapter.publishPost(
          { accessToken: "x", externalAccountId: "y" },
          { caption: "", hashtags: [], assetStoragePaths: [], assetUrls: [], mediaType: "image" },
        ),
      ).rejects.toBeInstanceOf(SocialProviderNotImplementedError);
    }
  });
});
