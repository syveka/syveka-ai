import "server-only";

import { mockEmailChannelAdapter } from "./mock";
import { resendEmailChannelAdapter } from "./resend";
import type { EmailChannelAdapter } from "./types";

function shouldUseMockProvider(): boolean {
  return (
    process.env.INBOX_EMAIL_MOCK_PROVIDER === "1" ||
    (process.env.NODE_ENV !== "production" && !resendEmailChannelAdapter.isConfigured())
  );
}

/** Active email channel adapter for this environment. */
export function getEmailChannelAdapter(): EmailChannelAdapter {
  return shouldUseMockProvider() ? mockEmailChannelAdapter : resendEmailChannelAdapter;
}

/**
 * Whether real inbound email can reach this app at all: a domain to
 * provision org mailboxes under (`getOrCreateMailbox`) and the signing
 * secret the Resend inbound webhook fails closed without. Presence only —
 * never exposes the values.
 */
export function isInboundEmailConfigured(): boolean {
  return Boolean(process.env.INBOX_EMAIL_DOMAIN && process.env.RESEND_INBOUND_WEBHOOK_SECRET);
}

export type { EmailChannelAdapter, OutboundEmail, SentEmail } from "./types";
export { EmailChannelError } from "./types";
