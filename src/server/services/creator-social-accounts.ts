import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import type { SocialPlatform } from "@prisma/client";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";
import { audit } from "./audit";
import { getSocialPublishingProvider } from "@/server/social";
import { encryptSocialToken, decryptSocialToken } from "@/server/integrations/social/crypto";
import type { SocialAccount } from "@prisma/client";

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

/** Phase 11: OAuth connect. `authCode` is whatever the provider's callback hands back (mock: any string). */
export async function connectSocialAccount(
  ctx: TenantContext,
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
