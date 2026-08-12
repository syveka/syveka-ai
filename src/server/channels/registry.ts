import "server-only";

import type { InboxChannel } from "@prisma/client";
import { getEmailChannelAdapter } from "./email";
import type { EmailChannelAdapter } from "./email/types";

/**
 * Provider-agnostic outbound message shape shared by every Inbox channel.
 * `subject` is meaningful for EMAIL and ignored by channels that don't have
 * one; adapters for those channels simply don't read it.
 */
export type OutboundChannelMessage = {
  to: string;
  body: string;
  subject?: string;
  /** Provider message id being replied to, for threading. */
  replyToExternalId?: string;
};

export type SentChannelMessage = {
  externalId: string;
};

export interface ChannelSendAdapter {
  send(message: OutboundChannelMessage): Promise<SentChannelMessage>;
}

function asChannelSendAdapter(adapter: EmailChannelAdapter): ChannelSendAdapter {
  return {
    send: (message) =>
      adapter.send({
        to: message.to,
        subject: message.subject ?? "Re: your message",
        text: message.body,
        inReplyToExternalId: message.replyToExternalId,
      }),
  };
}

/**
 * Resolves the outbound adapter for a thread's channel, or `null` if no
 * provider is wired up for it yet (SMS/WhatsApp/web chat are reserved in the
 * schema but have no adapter implementation yet). Adding a channel is a
 * one-line addition here — call sites never branch on channel themselves.
 */
export function getChannelAdapter(channel: InboxChannel): ChannelSendAdapter | null {
  switch (channel) {
    case "EMAIL":
      return asChannelSendAdapter(getEmailChannelAdapter());
    case "SMS":
    case "WHATSAPP":
    case "WEB_CHAT":
      return null;
  }
}
