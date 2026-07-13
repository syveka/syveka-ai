import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CalendarProvider } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { audit } from "./audit";
import { getProviderAdapter } from "@/server/integrations/calendar";
import { encryptToken, decryptToken } from "@/server/integrations/calendar/crypto";
import { ProviderError, type OAuthTokens } from "@/server/integrations/calendar/types";
import { clientEnv } from "@/env";
import type { TenantContext } from "@/server/auth/session";

export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "not_configured" | "bad_state" | "provider_error",
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

// ── OAuth state: HMAC-signed, expiring, tenant-bound ─────────────────────

function stateSecret(): string {
  // Reuse the QStash signing key material as HMAC secret if a dedicated one
  // is not configured; state only needs integrity, not confidentiality.
  return process.env.CALENDAR_OAUTH_STATE_SECRET ?? process.env.QSTASH_CURRENT_SIGNING_KEY ?? "dev";
}

export function buildOAuthState(ctx: TenantContext, provider: CalendarProvider): string {
  const payload = `${ctx.orgId}.${ctx.userId}.${provider}.${Date.now()}.${randomBytes(8).toString("hex")}`;
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifyOAuthState(state: string): {
  orgId: string;
  userId: string;
  provider: CalendarProvider;
} {
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw new ConnectionError("Malformed state", "bad_state");
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ConnectionError("Invalid state signature", "bad_state");
  }
  const [orgId, userId, provider, issuedAt] = payload.split(".");
  if (!orgId || !userId || !provider || !issuedAt) {
    throw new ConnectionError("Malformed state payload", "bad_state");
  }
  if (Date.now() - Number(issuedAt) > 10 * 60_000) {
    throw new ConnectionError("State expired", "bad_state");
  }
  return { orgId, userId, provider: provider as CalendarProvider };
}

export function oauthRedirectUri(provider: CalendarProvider): string {
  return `${clientEnv.NEXT_PUBLIC_APP_URL}/api/v1/integrations/calendar/${provider.toLowerCase()}/callback`;
}

// ── Connection lifecycle ─────────────────────────────────────────────────

export async function listConnections(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.calendarConnection.findMany({
    where: { userId: ctx.userId },
    select: {
      id: true,
      provider: true,
      accountEmail: true,
      status: true,
      lastError: true,
      lastCheckedAt: true,
      createdAt: true,
      calendars: {
        select: {
          id: true,
          externalId: true,
          name: true,
          isPrimary: true,
          syncEnabled: true,
          syncState: { select: { lastSyncedAt: true, lastSyncStatus: true, failureCount: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export function startConnectionUrl(ctx: TenantContext, provider: CalendarProvider): string {
  const adapter = getProviderAdapter(provider);
  if (!adapter.isConfigured()) {
    throw new ConnectionError(`${provider} OAuth is not configured`, "not_configured");
  }
  return adapter.getAuthUrl({
    redirectUri: oauthRedirectUri(provider),
    state: buildOAuthState(ctx, provider),
  });
}

/** OAuth callback: exchanges the code, stores encrypted tokens, lists calendars. */
export async function completeConnection(params: {
  provider: CalendarProvider;
  code: string;
  state: string;
}): Promise<{ orgId: string; connectionId: string }> {
  const { orgId, userId, provider } = verifyOAuthState(params.state);
  if (provider !== params.provider) throw new ConnectionError("Provider mismatch", "bad_state");

  const adapter = getProviderAdapter(provider);
  const tokens = await adapter.exchangeCode({
    code: params.code,
    redirectUri: oauthRedirectUri(provider),
  });

  const connection = await unscopedPrisma.calendarConnection.upsert({
    where: { organizationId_userId_provider: { organizationId: orgId, userId, provider } },
    create: {
      organizationId: orgId,
      userId,
      provider,
      accountEmail: tokens.accountEmail ?? null,
      accessTokenEnc: encryptToken(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes,
      status: "CONNECTED",
      lastCheckedAt: new Date(),
    },
    update: {
      accountEmail: tokens.accountEmail ?? null,
      accessTokenEnc: encryptToken(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : undefined,
      tokenExpiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes,
      status: "CONNECTED",
      lastError: null,
      lastCheckedAt: new Date(),
    },
  });

  // Discover calendars (idempotent upsert by (connectionId, externalId)).
  const calendars = await adapter.listCalendars(tokens);
  for (const cal of calendars) {
    await unscopedPrisma.externalCalendar.upsert({
      where: {
        connectionId_externalId: { connectionId: connection.id, externalId: cal.externalId },
      },
      create: {
        connectionId: connection.id,
        organizationId: orgId,
        externalId: cal.externalId,
        name: cal.name,
        isPrimary: cal.isPrimary,
        timezone: cal.timezone ?? null,
      },
      update: { name: cal.name, isPrimary: cal.isPrimary, timezone: cal.timezone ?? null },
    });
  }

  await audit(
    { orgId, userId },
    {
      action: "integration.calendar.connect",
      resourceType: "calendar_connection",
      resourceId: connection.id,
      after: { provider, accountEmail: tokens.accountEmail ?? null },
    },
  ).catch(() => undefined);

  return { orgId, connectionId: connection.id };
}

/** Decrypted, refreshed-when-needed tokens for a connection. */
export async function getFreshTokens(connectionId: string): Promise<OAuthTokens> {
  const conn = await unscopedPrisma.calendarConnection.findUnique({
    where: { id: connectionId },
  });
  if (!conn || !conn.accessTokenEnc) throw new ConnectionError("Connection not found", "not_found");

  const adapter = getProviderAdapter(conn.provider);
  const needsRefresh =
    conn.tokenExpiresAt !== null && conn.tokenExpiresAt.getTime() < Date.now() + 120_000;

  if (!needsRefresh) {
    return {
      accessToken: decryptToken(conn.accessTokenEnc),
      refreshToken: conn.refreshTokenEnc ? decryptToken(conn.refreshTokenEnc) : undefined,
      expiresAt: conn.tokenExpiresAt ?? undefined,
      scopes: conn.scopes,
      accountEmail: conn.accountEmail ?? undefined,
    };
  }

  if (!conn.refreshTokenEnc) {
    await markConnectionStatus(
      connectionId,
      "NEEDS_REAUTH",
      "Access token expired; no refresh token",
    );
    throw new ProviderError("No refresh token", "token_expired");
  }

  try {
    const refreshed = await adapter.refreshTokens(decryptToken(conn.refreshTokenEnc));
    await unscopedPrisma.calendarConnection.update({
      where: { id: connectionId },
      data: {
        accessTokenEnc: encryptToken(refreshed.accessToken),
        refreshTokenEnc: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : undefined,
        tokenExpiresAt: refreshed.expiresAt ?? null,
        status: "CONNECTED",
        lastError: null,
        lastCheckedAt: new Date(),
      },
    });
    return refreshed;
  } catch (e) {
    await markConnectionStatus(
      connectionId,
      "NEEDS_REAUTH",
      e instanceof Error ? e.message : "Token refresh failed",
    );
    throw e;
  }
}

export async function markConnectionStatus(
  connectionId: string,
  status: "CONNECTED" | "NEEDS_REAUTH" | "ERROR" | "DISCONNECTED",
  lastError?: string,
): Promise<void> {
  await unscopedPrisma.calendarConnection
    .update({
      where: { id: connectionId },
      data: { status, lastError: lastError ?? null, lastCheckedAt: new Date() },
    })
    .catch(() => undefined);
}

/** Enable/disable sync for one calendar of the caller's connection. */
export async function setCalendarSyncEnabled(
  ctx: TenantContext,
  externalCalendarId: string,
  enabled: boolean,
): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const calendar = await db.externalCalendar.findFirst({
    where: { id: externalCalendarId, connection: { userId: ctx.userId } },
    select: { id: true, name: true },
  });
  if (!calendar) throw new ConnectionError("Calendar not found", "not_found");

  await db.externalCalendar.update({
    where: { id: externalCalendarId },
    data: { syncEnabled: enabled },
  });
  if (!enabled) {
    await unscopedPrisma.calendarSyncState.deleteMany({
      where: { externalCalendarId },
    });
  }
  await audit(ctx, {
    action: enabled ? "integration.calendar.sync_enable" : "integration.calendar.sync_disable",
    resourceType: "external_calendar",
    resourceId: externalCalendarId,
    after: { name: calendar.name, enabled },
  });
}

/** Graceful disconnect: revoke remotely (best effort), then purge secrets. */
export async function disconnectConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const conn = await db.calendarConnection.findFirst({
    where: { id: connectionId, userId: ctx.userId },
    include: { calendars: { include: { syncState: true } } },
  });
  if (!conn) throw new ConnectionError("Connection not found", "not_found");

  const adapter = getProviderAdapter(conn.provider);

  // Best-effort webhook unsubscription + token revocation.
  try {
    const tokens = await getFreshTokens(connectionId);
    for (const cal of conn.calendars) {
      if (cal.syncState?.webhookSubscriptionId) {
        await adapter
          .unsubscribeWebhook(tokens, {
            subscriptionId: cal.syncState.webhookSubscriptionId,
            resourceId: cal.syncState.webhookResourceId ?? undefined,
          })
          .catch(() => undefined);
      }
    }
    await adapter.revoke(tokens).catch(() => undefined);
  } catch {
    // Remote cleanup is best-effort; local purge always proceeds.
  }

  await unscopedPrisma.calendarConnection.update({
    where: { id: connectionId },
    data: {
      status: "DISCONNECTED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      lastError: null,
    },
  });
  // Imported events stay (source of record for past meetings); external
  // linkage remains for a clean reconnect.
  await audit(ctx, {
    action: "integration.calendar.disconnect",
    resourceType: "calendar_connection",
    resourceId: connectionId,
    before: { provider: conn.provider },
  });
}

/** Connection health probe for the settings UI. */
export async function checkConnectionHealth(ctx: TenantContext, connectionId: string) {
  const db = tenantDb(ctx.orgId);
  const conn = await db.calendarConnection.findFirst({
    where: { id: connectionId, userId: ctx.userId },
    select: { id: true, provider: true, status: true },
  });
  if (!conn) throw new ConnectionError("Connection not found", "not_found");
  try {
    const tokens = await getFreshTokens(connectionId);
    await getProviderAdapter(conn.provider).listCalendars(tokens);
    await markConnectionStatus(connectionId, "CONNECTED");
    return { status: "CONNECTED" as const };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Health check failed";
    const status =
      e instanceof ProviderError && e.code === "token_expired" ? "NEEDS_REAUTH" : "ERROR";
    await markConnectionStatus(connectionId, status, message);
    return { status, message };
  }
}
