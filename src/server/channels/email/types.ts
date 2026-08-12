/**
 * Provider abstraction for the Inbox email channel. Real sending goes
 * through Resend; the mock adapter powers tests and credential-less
 * environments so the draft → approve → send pipeline is exercisable
 * end-to-end without a provider account.
 */

export type OutboundEmail = {
  to: string;
  subject: string;
  /** Plain-text body. Reply threading uses this verbatim, no template. */
  text: string;
  html?: string;
  replyTo?: string;
  /** Provider message id being replied to, for In-Reply-To/References headers. */
  inReplyToExternalId?: string;
};

export type SentEmail = {
  externalId: string;
};

export interface EmailChannelAdapter {
  readonly provider: "RESEND" | "MOCK";
  /** True when credentials are configured for this environment. */
  isConfigured(): boolean;
  send(email: OutboundEmail): Promise<SentEmail>;
}

export class EmailChannelError extends Error {
  constructor(
    message: string,
    public readonly code: "not_configured" | "rate_limited" | "remote_error",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "EmailChannelError";
  }
}

/**
 * Canonical inbound message — the ONE shape every provider adapter (and,
 * later, every channel) normalizes into before it reaches the Inbox domain
 * layer. Provider-specific payload fields must never leak past the adapter
 * that produced this.
 */
export type CanonicalInboundEmail = {
  provider: "resend" | "generic";
  /** Provider's own message id — used as `InboxMessage.externalId` for idempotency. */
  providerMessageId: string;
  /** The verified recipient address a mailbox was resolved from. */
  mailboxAddress: string;
  fromAddress: string;
  toAddresses: string[];
  subject?: string;
  /** Always plain text — HTML-only content is converted, never rendered raw. */
  text: string;
  receivedAt: Date;
  attachments?: Array<{ filename: string; contentType: string }>;
};
