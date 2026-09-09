import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import type { SocialPlatform } from "@prisma/client";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";
import { audit } from "./audit";
import { getSocialPublishingProvider } from "@/server/social";
import { metaAuthorizeUrl } from "@/server/social/meta-provider";
import { isMetaConfigured } from "@/server/integrations/meta/client";
import { buildSocialOAuthState, verifySocialOAuthState } from "@/server/social/oauth-state";
import { encryptSocialToken, decryptSocialToken } from "@/server/integrations/social/crypto";
import type { SocialAccount } from "@prisma/client";

export class SocialConnectError extends Error {
  constructor(
    message: string,
    public readonly code: "not_configured" | "bad_state",
  ) {
    super(message);
    this.name = "SocialConnectError";
  }
}

const META_PLATFORMS = new Set<SocialPlatform>(["INSTAGRAM", "FACEBOOK"]);

/** Never return token material to the caller (§17: tokens never reach the browser). */
function omitTokens(account: SocialAccount) {
  return {
    id: account.id,
    organizationId: account.organizationId,
    platform: account.platform,
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    scopes: account.scopes,
    status: account.status,
    tokenExpiresAt: account.tokenExpiresAt,
    lastError: account.lastError,
    lastCheckedAt: account.lastCheckedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/**
 * Phase 11: OAuth connect. `authCode` is whatever the provider's callback
 * hands back — for the mock provider, any string; for the real Meta
 * adapter, the `code` query param from Meta's OAuth redirect.
 * `ctx` is intentionally the minimal Pick, not the full TenantContext: the
 * Meta OAuth callback route (no browser session — see
 * completeMetaOAuthCallback below) only has org/user id from the signed
 * state param, not a full session.
 */
export async function connectSocialAccount(
  ctx: Pick<TenantContext, "orgId" | "userId">,
  params: { platform: SocialPlatform; authCode: string },
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const provider = getSocialPublishingProvider(params.platform);
  const connection = await provider.connectAccount(params.authCode);

  const db = tenantDb(ctx.orgId);
  const account = await db.socialAccount.upsert({
    where: {
      organizationId_platform_externalAccountId: {
        organizationId: ctx.orgId,
        platform: params.platform,
        externalAccountId: connection.externalAccountId,
      },
    },
    create: {
      organizationId: ctx.orgId,
      platform: params.platform,
      externalAccountId: connection.externalAccountId,
      displayName: connection.displayName,
      accessTokenEnc: encryptSocialToken(connection.accessToken),
      refreshTokenEnc: connection.refreshToken ? encryptSocialToken(connection.refreshToken) : null,
      scopes: connection.scopes,
      tokenExpiresAt: connection.tokenExpiresAt,
      status: "CONNECTED",
      lastCheckedAt: new Date(),
    },
    update: {
      displayName: connection.displayName,
      accessTokenEnc: encryptSocialToken(connection.accessToken),
      refreshTokenEnc: connection.refreshToken ? encryptSocialToken(connection.refreshToken) : null,
      scopes: connection.scopes,
      tokenExpiresAt: connection.tokenExpiresAt,
      status: "CONNECTED",
      lastError: null,
      lastCheckedAt: new Date(),
    },
  });

  await audit(ctx, {
    action: "creator.social_account.connect",
    resourceType: "social_account",
    resourceId: account.id,
    after: { platform: params.platform, displayName: connection.displayName },
  });

  return omitTokens(account);
}

/**
 * Builds the Meta OAuth authorize URL for INSTAGRAM/FACEBOOK, binding the
 * flow to (org, user, platform) via signed state — mirrors
 * startConnectionUrl() in calendar-connections.ts. The caller (a server
 * action) redirects the browser to this URL; Meta redirects back to
 * completeMetaOAuthCallback below.
 */
export function startMetaOAuthUrl(ctx: TenantContext, platform: SocialPlatform): string {
  if (!META_PLATFORMS.has(platform)) {
    throw new SocialConnectError(`${platform} has no OAuth flow`, "not_configured");
  }
  if (!isMetaConfigured()) {
    throw new SocialConnectError("Meta Graph API is not configured", "not_configured");
  }
  const state = buildSocialOAuthState(ctx.orgId, ctx.userId, platform);
  return metaAuthorizeUrl(state);
}

/**
 * Meta OAuth callback completion: verifies the signed state (no session
 * cookie is trusted here — this is a top-level redirect from Meta, exactly
 * like completeConnection() in calendar-connections.ts), then connects the
 * account under the org/user/platform the state was signed for. Meta's
 * redirect only ever echoes back `code`/`state`/`error` — the platform
 * comes solely from the cryptographically-bound state, never from a
 * caller-supplied value.
 */
export async function completeMetaOAuthCallback(params: {
  code: string;
  state: string;
}): Promise<{ orgId: string; accountId: string }> {
  const { orgId, userId, platform } = verifySocialOAuthState(params.state);
  const account = await connectSocialAccount(
    { orgId, userId },
    { platform, authCode: params.code },
  );
  return { orgId, accountId: account.id };
}

export async function listSocialAccounts(ctx: TenantContext) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const accounts = await db.socialAccount.findMany({ orderBy: { createdAt: "desc" } });
  return accounts.map(omitTokens);
}

export async function disconnectSocialAccount(ctx: TenantContext, id: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const account = await db.socialAccount.findFirstOrThrow({ where: { id } });

  if (account.accessTokenEnc) {
    const provider = getSocialPublishingProvider(account.platform);
    await provider
      .revokeConnection(decryptSocialToken(account.accessTokenEnc))
      .catch(() => undefined);
  }

  const updated = await db.socialAccount.update({
    where: { id },
    data: { status: "DISCONNECTED", accessTokenEnc: null, refreshTokenEnc: null },
  });
  await audit(ctx, {
    action: "creator.social_account.disconnect",
    resourceType: "social_account",
    resourceId: id,
  });
  return omitTokens(updated);
}
