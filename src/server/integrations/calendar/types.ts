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
  /**
   * Our own CalendarEvent id, round-tripped back by the provider when this
   * remote event was originally created by our own outbound push (P2 fix:
   * outbound/inbound duplicate race). Present only when the provider
   * supports it (Google: `extendedProperties.private`) and only for events
   * we pushed — absent for genuinely external events. Undefined, never a
   * client-supplied/untrusted value from anywhere but our own prior push.
   */
  correlationId?: string;
};

export type SyncPage = {
  events: ExternalEvent[];
  /** Ids removed remotely since the last cursor (incremental sync). */
  deletedExternalIds: string[];
  /**
   * Cursor to persist for the NEXT sync run (sync token / delta link).
   * Providers return one even on the final page, so it must never be used
   * as a "more pages" signal — that is what `hasMore` is for.
   */
  nextCursor: string | null;
  /** True only when more pages exist within the CURRENT sync run. */
  hasMore: boolean;
  /** Cursor invalidated remotely → caller must full-resync. */
  cursorExpired?: boolean;
};

export type WebhookSubscription = {
  subscriptionId: string;
  resourceId?: string;
  expiresAt?: Date;
};

/** A Syveka-originated event to push-create on the provider (P2: booking lifecycle unification). */
export type CreateEventInput = {
  title: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  /**
   * Our own CalendarEvent id. Providers that support private extended/custom
   * properties (Google) should stamp it on the created event so a later
   * inbound sync can recognize "this remote event is actually mine, just not
   * yet linked" instead of creating a duplicate row — see `ExternalEvent`'s
   * matching field and `applyRemoteEvent` in calendar-sync.ts.
   */
  correlationId: string;
};

export type CreateEventResult = {
  externalId: string;
  etag?: string;
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
  /**
   * `verificationSecret` is a caller-generated, one-time-use-at-subscribe value (P0.2):
   * Google sends it as the watch channel `token`; Microsoft sends it as `clientState`.
   * It is never returned — only the caller's hash of it is ever persisted.
   */
  subscribeWebhook(
    tokens: OAuthTokens,
    calendarExternalId: string,
    callbackUrl: string,
    verificationSecret: string,
  ): Promise<WebhookSubscription | null>;
  unsubscribeWebhook(tokens: OAuthTokens, subscription: WebhookSubscription): Promise<void>;

  /**
   * Push-create a Syveka-originated event on the provider (P2: booking
   * lifecycle unification, Google only for now). Optional — a provider that
   * doesn't yet support outbound push simply omits it; callers must check
   * for its presence (`typeof adapter.createEvent === "function"`) before
   * calling and degrade to a no-op (booking still succeeds locally).
   */
  createEvent?(
    tokens: OAuthTokens,
    calendarExternalId: string,
    event: CreateEventInput,
  ): Promise<CreateEventResult>;

  /**
   * Push-cancel a previously push-created event. MUST be idempotent: a
   * "not found" response (the event is already gone, or was manually
   * deleted on the provider) is a successful no-op, not an error — never
   * throw for that case.
   */
  cancelEvent?(
    tokens: OAuthTokens,
    calendarExternalId: string,
    externalEventId: string,
  ): Promise<void>;
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
