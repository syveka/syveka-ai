import "server-only";

import { randomUUID } from "node:crypto";
import type {
  SocialPublishingProvider,
  SocialAccountConnection,
  SocialPublishRequest,
  SocialPublishResult,
  SocialPublishStatus,
} from "./types";

/**
 * Deterministic in-memory publishing provider. Used by unit/integration/E2E
 * tests and as a safe stand-in in dev/CI, where no real Instagram/Facebook/
 * TikTok/YouTube app credentials exist — the whole connect → publish →
 * status pipeline is exercisable end-to-end without any external call.
 * Mirrors src/server/integrations/calendar/mock.ts's role for calendar.
 */
class MockSocialPublishingProvider implements SocialPublishingProvider {
  constructor(readonly platform: string) {}

  readonly capability = "full" as const;

  isConfigured(): boolean {
    return true;
  }

  async connectAccount(authCode: string): Promise<SocialAccountConnection> {
    return {
      externalAccountId: `mock_${this.platform.toLowerCase()}_${authCode || randomUUID()}`,
      displayName: `Mock ${this.platform} Account`,
      accessToken: `mock_access_${randomUUID()}`,
      refreshToken: `mock_refresh_${randomUUID()}`,
      scopes: ["publish_content"],
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    };
  }

  async refreshConnection(_refreshToken: string): Promise<SocialAccountConnection> {
    return this.connectAccount(randomUUID());
  }

  async publishPost(
    connection: { accessToken: string; externalAccountId: string },
    _req: SocialPublishRequest,
  ): Promise<SocialPublishResult> {
    if (!connection.accessToken) throw new Error("Missing access token");
    return {
      externalPostId: `mock_post_${randomUUID()}`,
      providerRequestId: `mock_req_${randomUUID()}`,
    };
  }

  async getPublishStatus(_externalPostId: string): Promise<SocialPublishStatus> {
    return "published";
  }

  async revokeConnection(_accessToken: string): Promise<void> {
    // no-op: nothing external to revoke
  }
}

export function createMockSocialProvider(platform: string): SocialPublishingProvider {
  return new MockSocialPublishingProvider(platform);
}
