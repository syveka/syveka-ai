import "server-only";

import { z } from "zod";
import type { CanonicalInboundEmail } from "./types";

/**
 * Resend's `email.received` webhook event — verified via
 * https://resend.com/docs/webhooks/emails/received (fetched and confirmed
 * during implementation, not guessed). Deliberately narrow: the webhook
 * payload itself carries only metadata, never the body — Resend requires a
 * follow-up API call (`fetchReceivedEmailContent`) for that, specifically
 * to keep webhook payloads small.
 */
const resendReceivedEventSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string().min(1),
    to: z.array(z.string()).min(1),
    subject: z.string().optional(),
  }),
});

export type ResendReceivedEvent = z.infer<typeof resendReceivedEventSchema>;

export function parseResendReceivedEvent(payload: unknown): ResendReceivedEvent | null {
  const result = resendReceivedEventSchema.safeParse(payload);
  return result.success ? result.data : null;
}

/**
 * Verifies the request came from Resend using the svix-signed headers
 * (svix-id/svix-timestamp/svix-signature) their webhooks carry — the
 * mechanism Resend's own docs recommend, verified during implementation.
 * The raw (unparsed) body is required: signatures are computed over exact
 * bytes, and any re-serialization would invalidate them.
 */
export async function verifyResendWebhookSignature(
  rawBody: string,
  headers: {
    "svix-id": string | null;
    "svix-timestamp": string | null;
    "svix-signature": string | null;
  },
  secret: string,
): Promise<boolean> {
  if (!headers["svix-id"] || !headers["svix-timestamp"] || !headers["svix-signature"]) {
    return false;
  }
  const { Webhook } = await import("svix");
  try {
    new Webhook(secret).verify(rawBody, {
      "svix-id": headers["svix-id"],
      "svix-timestamp": headers["svix-timestamp"],
      "svix-signature": headers["svix-signature"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Strips markup for storage/display as plain text — this is a readability
 * conversion, NOT a sanitizer producing safe-to-render HTML. Inbound
 * content is only ever stored and rendered as plain text (React-escaped);
 * raw inbound HTML is never rendered as HTML anywhere in this codebase.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * GET /emails/receiving/{id} — verified during implementation (Resend docs).
 * Not yet in the pinned `resend` SDK version, so called directly.
 */
export async function fetchReceivedEmailContent(
  emailId: string,
  apiKey: string,
): Promise<{ text: string; html: string | null }> {
  const res = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!res.ok) {
    throw new Error(`Resend receiving API returned ${res.status}`);
  }
  const body = (await res.json()) as { text?: string | null; html?: string | null };
  return { text: body.text ?? "", html: body.html ?? null };
}

/**
 * Combines the webhook event + fetched content into the canonical shape.
 * Prefers the plain-text body; falls back to a stripped-markup version of
 * the HTML body only when no plain-text alternative exists.
 */
export function normalizeResendInboundEmail(
  event: ResendReceivedEvent,
  content: { text: string; html: string | null },
  mailboxAddress: string,
): CanonicalInboundEmail {
  const text = content.text.trim() || (content.html ? htmlToPlainText(content.html) : "");
  return {
    provider: "resend",
    providerMessageId: event.data.email_id,
    mailboxAddress,
    fromAddress: event.data.from,
    toAddresses: event.data.to,
    subject: event.data.subject,
    text,
    receivedAt: new Date(),
  };
}
