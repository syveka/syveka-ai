import type { CalendarProvider } from "@prisma/client";

/**
 * Provider abstraction for external calendar integrations.
 * Google and Microsoft implement this interface over raw REST (no SDK
 * dependencies); the mock adapter powers tests and credential-less
 * environments. All methods take decrypted tokens — encryption at rest is
 * the connection service's responsibility, never the adapter's.
 */

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  accountEmail?: string;
};

export type ExternalCalendarInfo = {
  externalId: string;
  name: string;
  isPrimary: boolean;
  timezone?: string;
};

export type ExternalEvent = {
  externalId: string;
  etag?: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  attendees: Array<{ email?: string; name?: string }>;
};

export type SyncPage = {
  events: ExternalEvent[];
  /** Ids removed remotely since the last cursor (incremental sync). */
  deletedExternalIds: string[];
  nextCursor: string | null;
  /** Cursor invalidated remotely → caller must full-resync. */
  cursorExpired?: boolean;
};

export type WebhookSubscription = {
  subscriptionId: string;
  resourceId?: string;
  expiresAt?: Date;
};

export interface CalendarProviderAdapter {
  readonly provider: CalendarProvider;
  /** True when client id/secret are configured for this environment. */
  isConfigured(): boolean;
  getAuthUrl(params: { redirectUri: string; state: string }): string;
  exchangeCode(params: { code: string; redirectUri: string }): Promise<OAuthTokens>;
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  revoke(tokens: OAuthTokens): Promise<void>;
  listCalendars(tokens: OAuthTokens): Promise<ExternalCalendarInfo[]>;
  /** Incremental when cursor given; full window otherwise. Idempotent. */
  listEvents(
    tokens: OAuthTokens,
    calendarExternalId: string,
    cursor: string | null,
  ): Promise<SyncPage>;
  subscribeWebhook(
    tokens: OAuthTokens,
    calendarExternalId: string,
    callbackUrl: string,
  ): Promise<WebhookSubscription | null>;
  unsubscribeWebhook(tokens: OAuthTokens, subscription: WebhookSubscription): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_configured"
      | "auth_failed"
      | "token_expired"
      | "rate_limited"
      | "cursor_expired"
      | "remote_error",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
