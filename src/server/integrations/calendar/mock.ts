import type {
  CalendarProviderAdapter,
  ExternalCalendarInfo,
  ExternalEvent,
  OAuthTokens,
  SyncPage,
  WebhookSubscription,
} from "./types";

/**
 * Deterministic in-memory provider. Used by unit/integration tests and as a
 * safe stand-in in environments without Google/Microsoft credentials, so the
 * whole connection → calendar selection → sync pipeline is exercisable
 * end-to-end. Never enabled in production unless CALENDAR_MOCK_PROVIDER=1.
 */

type MockState = {
  calendars: ExternalCalendarInfo[];
  eventsByCalendar: Map<string, ExternalEvent[]>;
  deletedByCalendar: Map<string, string[]>;
  cursorCounter: number;
};

function freshState(): MockState {
  return {
    calendars: [
      {
        externalId: "mock-primary",
        name: "Mock Primary",
        isPrimary: true,
        timezone: "Europe/Helsinki",
      },
      { externalId: "mock-team", name: "Mock Team", isPrimary: false, timezone: "Europe/Helsinki" },
    ],
    eventsByCalendar: new Map(),
    deletedByCalendar: new Map(),
    cursorCounter: 0,
  };
}

let state = freshState();

/** Test hooks. */
export const mockProviderTestApi = {
  reset(): void {
    state = freshState();
  },
  seedEvents(calendarExternalId: string, events: ExternalEvent[]): void {
    state.eventsByCalendar.set(calendarExternalId, events);
  },
  markDeleted(calendarExternalId: string, externalIds: string[]): void {
    state.deletedByCalendar.set(calendarExternalId, externalIds);
  },
};

export const mockCalendarAdapter: CalendarProviderAdapter = {
  provider: "MOCK",

  isConfigured() {
    return true;
  },

  getAuthUrl({ redirectUri, state: oauthState }) {
    // Immediately "authorizes": the callback URL with a fixed code.
    return `${redirectUri}?code=mock-auth-code&state=${encodeURIComponent(oauthState)}`;
  },

  async exchangeCode(): Promise<OAuthTokens> {
    return {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["mock:calendar"],
      accountEmail: "mock@example.com",
    };
  },

  async refreshTokens(): Promise<OAuthTokens> {
    return {
      accessToken: `mock-access-token-${Date.now()}`,
      refreshToken: "mock-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["mock:calendar"],
    };
  },

  async revoke(): Promise<void> {
    // no-op
  },

  async listCalendars(): Promise<ExternalCalendarInfo[]> {
    return state.calendars;
  },

  async listEvents(_tokens, calendarExternalId, cursor): Promise<SyncPage> {
    // Cursor "mock-expired" simulates a remote 410 for resync tests.
    if (cursor === "mock-expired") {
      return { events: [], deletedExternalIds: [], nextCursor: null, cursorExpired: true };
    }
    state.cursorCounter += 1;
    return {
      events: state.eventsByCalendar.get(calendarExternalId) ?? [],
      deletedExternalIds: state.deletedByCalendar.get(calendarExternalId) ?? [],
      nextCursor: `mock-cursor-${state.cursorCounter}`,
    };
  },

  async subscribeWebhook(): Promise<WebhookSubscription> {
    return {
      subscriptionId: `mock-sub-${Date.now()}`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    };
  },

  async unsubscribeWebhook(): Promise<void> {
    // no-op
  },
};
