import "server-only";

import {
  ProviderError,
  type CalendarProviderAdapter,
  type ExternalCalendarInfo,
  type ExternalEvent,
  type SyncPage,
  type WebhookSubscription,
} from "./types";

/**
 * Microsoft 365 / Outlook Calendar adapter (Graph REST, no SDK).
 * Env: MICROSOFT_CALENDAR_CLIENT_ID / MICROSOFT_CALENDAR_CLIENT_SECRET /
 *      MICROSOFT_CALENDAR_TENANT (default "common").
 * Incremental sync uses Graph delta queries (@odata.deltaLink); webhooks use
 * Graph change-notification subscriptions (max ~3 days, renewed by cron).
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "openid", "email", "Calendars.ReadWrite"];

function tenant(): string {
  return process.env.MICROSOFT_CALENDAR_TENANT ?? "common";
}
function clientId(): string | undefined {
  return process.env.MICROSOFT_CALENDAR_CLIENT_ID;
}
function clientSecret(): string | undefined {
  return process.env.MICROSOFT_CALENDAR_CLIENT_SECRET;
}
function authBase(): string {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;
}

async function graphFetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new ProviderError("Graph token rejected", "token_expired");
  if (res.status === 410) throw new ProviderError("Delta link expired", "cursor_expired");
  if (res.status === 429) throw new ProviderError("Graph rate limit", "rate_limited", true);
  if (!res.ok)
    throw new ProviderError(`Graph API ${res.status}`, "remote_error", res.status >= 500);
  return (await res.json()) as T;
}

type GraphEvent = {
  id: string;
  "@odata.etag"?: string;
  "@removed"?: { reason: string };
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  isAllDay?: boolean;
  showAs?: string;
  isCancelled?: boolean;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  attendees?: Array<{ emailAddress?: { address?: string; name?: string } }>;
};

function graphDate(v?: { dateTime: string; timeZone: string }): Date {
  if (!v) return new Date(NaN);
  // Graph returns UTC when Prefer: outlook.timezone is not set.
  const iso = v.dateTime.endsWith("Z") ? v.dateTime : `${v.dateTime}Z`;
  return new Date(iso);
}

function mapEvent(e: GraphEvent): ExternalEvent | { deletedId: string } {
  if (e["@removed"] || e.isCancelled) return { deletedId: e.id };
  return {
    externalId: e.id,
    etag: e["@odata.etag"],
    title: e.subject ?? "(untitled)",
    description: e.bodyPreview,
    location: e.location?.displayName,
    startsAt: graphDate(e.start),
    endsAt: graphDate(e.end),
    allDay: Boolean(e.isAllDay),
    status: e.showAs === "tentative" ? "tentative" : "confirmed",
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.emailAddress?.address,
      name: a.emailAddress?.name,
    })),
  };
}

export const microsoftCalendarAdapter: CalendarProviderAdapter = {
  provider: "MICROSOFT",

  isConfigured() {
    return Boolean(clientId() && clientSecret());
  },

  getAuthUrl({ redirectUri, state }) {
    if (!this.isConfigured()) {
      throw new ProviderError("Microsoft OAuth not configured", "not_configured");
    }
    const q = new URLSearchParams({
      client_id: clientId()!,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: SCOPES.join(" "),
      state,
    });
    return `${authBase()}/authorize?${q.toString()}`;
  },

  async exchangeCode({ code, redirectUri }) {
    const res = await fetch(`${authBase()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId() ?? "",
        client_secret: clientSecret() ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: SCOPES.join(" "),
      }),
    });
    if (!res.ok) throw new ProviderError("Microsoft code exchange failed", "auth_failed");
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    };
    let accountEmail: string | undefined;
    if (data.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(data.id_token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ) as { email?: string; preferred_username?: string };
        accountEmail = payload.email ?? payload.preferred_username;
      } catch {
        accountEmail = undefined;
      }
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      scopes: data.scope?.split(" ") ?? SCOPES,
      accountEmail,
    };
  },

  async refreshTokens(refreshToken) {
    const res = await fetch(`${authBase()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId() ?? "",
        client_secret: clientSecret() ?? "",
        grant_type: "refresh_token",
        scope: SCOPES.join(" "),
      }),
    });
    if (!res.ok) throw new ProviderError("Microsoft token refresh failed", "auth_failed");
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      scopes: data.scope?.split(" ") ?? SCOPES,
    };
  },

  async revoke() {
    // Microsoft identity platform has no token revocation endpoint for
    // confidential clients; disconnect = delete stored tokens + subscription.
  },

  async listCalendars(tokens): Promise<ExternalCalendarInfo[]> {
    const data = await graphFetch<{
      value?: Array<{ id: string; name: string; isDefaultCalendar?: boolean }>;
    }>(`${GRAPH}/me/calendars?$top=50`, tokens.accessToken);
    return (data.value ?? []).map((c) => ({
      externalId: c.id,
      name: c.name,
      isPrimary: Boolean(c.isDefaultCalendar),
    }));
  },

  async listEvents(tokens, calendarExternalId, cursor): Promise<SyncPage> {
    const start = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const end = new Date(Date.now() + 180 * 86_400_000).toISOString();
    const url =
      cursor ??
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarExternalId)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
    try {
      const data = await graphFetch<{
        value?: GraphEvent[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }>(url, tokens.accessToken);
      const events: ExternalEvent[] = [];
      const deleted: string[] = [];
      for (const raw of data.value ?? []) {
        const mapped = mapEvent(raw);
        if ("deletedId" in mapped) deleted.push(mapped.deletedId);
        else events.push(mapped);
      }
      return {
        events,
        deletedExternalIds: deleted,
        // nextLink → more pages now; deltaLink → resume point later.
        nextCursor: data["@odata.nextLink"] ?? data["@odata.deltaLink"] ?? null,
        hasMore: Boolean(data["@odata.nextLink"]),
      };
    } catch (e) {
      if (e instanceof ProviderError && e.code === "cursor_expired") {
        return {
          events: [],
          deletedExternalIds: [],
          nextCursor: null,
          hasMore: false,
          cursorExpired: true,
        };
      }
      throw e;
    }
  },

  async subscribeWebhook(tokens, calendarExternalId, callbackUrl): Promise<WebhookSubscription> {
    const data = await graphFetch<{ id: string; expirationDateTime?: string }>(
      `${GRAPH}/subscriptions`,
      tokens.accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "created,updated,deleted",
          notificationUrl: callbackUrl,
          resource: `/me/calendars/${calendarExternalId}/events`,
          expirationDateTime: new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString(),
        }),
      },
    );
    return {
      subscriptionId: data.id,
      expiresAt: data.expirationDateTime ? new Date(data.expirationDateTime) : undefined,
    };
  },

  async unsubscribeWebhook(tokens, subscription) {
    await fetch(`${GRAPH}/subscriptions/${subscription.subscriptionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => undefined);
  },
};
