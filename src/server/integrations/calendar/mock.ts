import { ProviderError } from "./types";
import type {
  CalendarProviderAdapter,
  CreateEventInput,
  CreateEventResult,
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

/** Forced outcome for the next createEvent/cancelEvent call, for edge-case tests. */
type PushFailureMode = "provider_error" | "network_error";

type MockState = {
  calendars: ExternalCalendarInfo[];
  eventsByCalendar: Map<string, ExternalEvent[]>;
  deletedByCalendar: Map<string, string[]>;
  cursorCounter: number;
  pushedEvents: Map<string, CreateEventInput>; // externalId -> what was pushed
  eventIdCounter: number;
  nextCreateFailure: PushFailureMode | null;
  nextCancelFailure: PushFailureMode | null;
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
    pushedEvents: new Map(),
    eventIdCounter: 0,
    nextCreateFailure: null,
    nextCancelFailure: null,
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
  /** Forces the next createEvent() call to fail this way (one-shot). */
  forceNextCreateFailure(mode: PushFailureMode): void {
    state.nextCreateFailure = mode;
  },
  /** Forces the next cancelEvent() call to fail this way (one-shot). */
  forceNextCancelFailure(mode: PushFailureMode): void {
    state.nextCancelFailure = mode;
  },
  pushedEvents(): Map<string, CreateEventInput> {
    return state.pushedEvents;
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
      return {
        events: [],
        deletedExternalIds: [],
        nextCursor: null,
        hasMore: false,
        cursorExpired: true,
      };
    }
    state.cursorCounter += 1;
    return {
      events: state.eventsByCalendar.get(calendarExternalId) ?? [],
      deletedExternalIds: state.deletedByCalendar.get(calendarExternalId) ?? [],
      nextCursor: `mock-cursor-${state.cursorCounter}`,
      hasMore: false, // mock serves everything in one page
    };
  },

  async subscribeWebhook(
    _tokens,
    _calendarExternalId,
    _callbackUrl,
    _verificationSecret,
  ): Promise<WebhookSubscription> {
    return {
      subscriptionId: `mock-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    };
  },

  async unsubscribeWebhook(): Promise<void> {
    // no-op
  },

  async createEvent(
    _tokens,
    _calendarExternalId,
    event: CreateEventInput,
  ): Promise<CreateEventResult> {
    if (state.nextCreateFailure) {
      const mode = state.nextCreateFailure;
      state.nextCreateFailure = null;
      if (mode === "provider_error") {
        throw new ProviderError("Mock provider rejected the event", "remote_error");
      }
      // Simulates a network-level failure (no response received) - the case
      // callers must classify as AMBIGUOUS, not FAILED.
      throw new TypeError("mock network failure");
    }
    state.eventIdCounter += 1;
    const externalId = `mock-pushed-${state.eventIdCounter}`;
    state.pushedEvents.set(externalId, event);
    return { externalId, etag: `mock-etag-${state.eventIdCounter}` };
  },

  async cancelEvent(_tokens, _calendarExternalId, externalEventId): Promise<void> {
    if (state.nextCancelFailure) {
      const mode = state.nextCancelFailure;
      state.nextCancelFailure = null;
      if (mode === "provider_error") {
        throw new ProviderError("Mock provider rejected the cancellation", "remote_error");
      }
      throw new TypeError("mock network failure");
    }
    state.pushedEvents.delete(externalEventId); // idempotent: absent id is a silent no-op
  },
};
