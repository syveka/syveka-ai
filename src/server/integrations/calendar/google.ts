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
 * Google Calendar adapter (REST, no SDK).
 * Env: GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET.
 * Scopes: calendar.readonly + calendar.events. Incremental sync uses
 * syncToken (410 → cursor expired → full resync). Webhooks use
 * `events.watch` channels; Google posts to the callback with channel headers.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
];

function clientId(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_ID;
}
function clientSecret(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
}

async function googleFetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new ProviderError("Google token rejected", "token_expired");
  if (res.status === 410) throw new ProviderError("Sync token expired", "cursor_expired");
  if (res.status === 429) throw new ProviderError("Google rate limit", "rate_limited", true);
  if (!res.ok) {
    throw new ProviderError(`Google API ${res.status}`, "remote_error", res.status >= 500);
  }
  return (await res.json()) as T;
}

type GoogleEvent = {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: Array<{ email?: string; displayName?: string }>;
};

function mapEvent(e: GoogleEvent): ExternalEvent | { deletedId: string } {
  if (e.status === "cancelled") return { deletedId: e.id };
  const allDay = Boolean(e.start?.date);
  const startsAt = new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);
  const endsAt = new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`);
  return {
    externalId: e.id,
    etag: e.etag,
    title: e.summary ?? "(untitled)",
    description: e.description,
    location: e.location,
    startsAt,
    endsAt,
    allDay,
    status: e.status === "tentative" ? "tentative" : "confirmed",
    attendees: (e.attendees ?? []).map((a) => ({ email: a.email, name: a.displayName })),
  };
}

export const googleCalendarAdapter: CalendarProviderAdapter = {
  provider: "GOOGLE",

  isConfigured() {
    return Boolean(clientId() && clientSecret());
  },

  getAuthUrl({ redirectUri, state }) {
    if (!this.isConfigured())
      throw new ProviderError("Google OAuth not configured", "not_configured");
    const q = new URLSearchParams({
      client_id: clientId()!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTH_URL}?${q.toString()}`;
  },

  async exchangeCode({ code, redirectUri }) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId() ?? "",
        client_secret: clientSecret() ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) throw new ProviderError("Google code exchange failed", "auth_failed");
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
        ) as { email?: string };
        accountEmail = payload.email;
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
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId() ?? "",
        client_secret: clientSecret() ?? "",
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new ProviderError("Google token refresh failed", "auth_failed");
    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: data.access_token,
      refreshToken, // Google keeps the original refresh token
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      scopes: data.scope?.split(" ") ?? SCOPES,
    };
  },

  async revoke(tokens) {
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.accessToken)}`,
      {
        method: "POST",
      },
    ).catch(() => undefined);
  },

  async listCalendars(tokens): Promise<ExternalCalendarInfo[]> {
    const data = await googleFetch<{
      items?: Array<{ id: string; summary: string; primary?: boolean; timeZone?: string }>;
    }>(`${API}/users/me/calendarList`, tokens.accessToken);
    return (data.items ?? []).map((c) => ({
      externalId: c.id,
      name: c.summary,
      isPrimary: Boolean(c.primary),
      timezone: c.timeZone,
    }));
  },

  async listEvents(tokens, calendarExternalId, cursor): Promise<SyncPage> {
    const params = new URLSearchParams({ maxResults: "250", singleEvents: "true" });
    if (cursor) {
      params.set("syncToken", cursor);
    } else {
      params.set("timeMin", new Date(Date.now() - 30 * 86_400_000).toISOString());
      params.set("timeMax", new Date(Date.now() + 180 * 86_400_000).toISOString());
    }
    try {
      const data = await googleFetch<{
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>(
        `${API}/calendars/${encodeURIComponent(calendarExternalId)}/events?${params.toString()}`,
        tokens.accessToken,
      );
      const events: ExternalEvent[] = [];
      const deleted: string[] = [];
      for (const raw of data.items ?? []) {
        const mapped = mapEvent(raw);
        if ("deletedId" in mapped) deleted.push(mapped.deletedId);
        else events.push(mapped);
      }
      return {
        events,
        deletedExternalIds: deleted,
        nextCursor: data.nextPageToken ?? data.nextSyncToken ?? null,
      };
    } catch (e) {
      if (e instanceof ProviderError && e.code === "cursor_expired") {
        return { events: [], deletedExternalIds: [], nextCursor: null, cursorExpired: true };
      }
      throw e;
    }
  },

  async subscribeWebhook(tokens, calendarExternalId, callbackUrl): Promise<WebhookSubscription> {
    const channelId = crypto.randomUUID();
    const data = await googleFetch<{ resourceId?: string; expiration?: string }>(
      `${API}/calendars/${encodeURIComponent(calendarExternalId)}/events/watch`,
      tokens.accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channelId, type: "web_hook", address: callbackUrl }),
      },
    );
    return {
      subscriptionId: channelId,
      resourceId: data.resourceId,
      expiresAt: data.expiration ? new Date(Number(data.expiration)) : undefined,
    };
  },

  async unsubscribeWebhook(tokens, subscription) {
    await fetch(`${API}/channels/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: subscription.subscriptionId,
        resourceId: subscription.resourceId,
      }),
    }).catch(() => undefined);
  },
};
