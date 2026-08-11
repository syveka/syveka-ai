import type { EmailChannelAdapter, OutboundEmail, SentEmail } from "./types";

/**
 * Deterministic in-memory adapter. Used by unit/integration tests and as a
 * safe stand-in in environments without Resend credentials, so the
 * draft → approve → send pipeline is exercisable end-to-end. Never enabled
 * in production unless INBOX_EMAIL_MOCK_PROVIDER=1.
 */

type MockState = {
  sent: Array<OutboundEmail & { externalId: string }>;
  counter: number;
};

let state: MockState = { sent: [], counter: 0 };

/** Test hooks. */
export const mockEmailChannelTestApi = {
  reset(): void {
    state = { sent: [], counter: 0 };
  },
  getSent(): Array<OutboundEmail & { externalId: string }> {
    return state.sent;
  },
};

export const mockEmailChannelAdapter: EmailChannelAdapter = {
  provider: "MOCK",

  isConfigured() {
    return true;
  },

  async send(email: OutboundEmail): Promise<SentEmail> {
    state.counter += 1;
    const externalId = `mock-email-${state.counter}-${Date.now()}`;
    state.sent.push({ ...email, externalId });
    return { externalId };
  },
};
