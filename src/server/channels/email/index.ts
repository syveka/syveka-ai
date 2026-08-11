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

export type { EmailChannelAdapter, OutboundEmail, SentEmail } from "./types";
export { EmailChannelError } from "./types";
