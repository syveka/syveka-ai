import { NextResponse } from "next/server";
import {
  fetchReceivedEmailContent,
  normalizeResendInboundEmail,
  parseResendReceivedEvent,
  verifyResendWebhookSignature,
} from "@/server/channels/email/resend-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Real Resend `email.received` inbound webhook. Verified against Resend's
 * published documentation during implementation (signature mechanism,
 * event shape, and the content-retrieval API) rather than guessed.
 *
 * provider inbound event → verify (svix) → parse → resolve mailbox
 *   → fetch full body → canonical message → recordInboundMessage
 *
 * Fails closed at every boundary:
 * - `RESEND_INBOUND_WEBHOOK_SECRET` not configured → reject everything
 * - signature missing/invalid → reject
 * - none of the event's `to` addresses match a registered mailbox → reject
 *   (identical response either way — never confirms or denies an address)
 * - never logs the raw payload or message content, only outcome/error codes
 */
export async function POST(request: Request) {
  const webhookSecret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: { code: "not_configured" } }, { status: 503 });
  }

  // Signature verification requires the exact raw bytes — never parse
  // before verifying.
  const rawBody = await request.text();
  const verified = await verifyResendWebhookSignature(
    rawBody,
    {
      "svix-id": request.headers.get("svix-id"),
      "svix-timestamp": request.headers.get("svix-timestamp"),
      "svix-signature": request.headers.get("svix-signature"),
    },
    webhookSecret,
  );
  if (!verified) {
    return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  const parsedBody: unknown = JSON.parse(rawBody);
  const event = parseResendReceivedEvent(parsedBody);
  if (!event) {
    // Not an email.received event (Resend sends other event types to the
    // same endpoint if configured for them) — acknowledge without action.
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { resolveOrgIdByMailboxAddress } = await import("@/server/services/inbox-mailbox");
  let orgId: string | null = null;
  let mailboxAddress: string | null = null;
  for (const address of event.data.to) {
    orgId = await resolveOrgIdByMailboxAddress(address, "EMAIL");
    if (orgId) {
      mailboxAddress = address;
      break;
    }
  }
  if (!orgId || !mailboxAddress) {
    return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  const { rateLimiters } = await import("@/server/integrations/redis");
  const rateLimit = await rateLimiters.inboxEmailWebhook.limit(orgId);
  if (!rateLimit.success) {
    return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
  }

  const { getResendEnv } = await import("@/env");
  const { RESEND_API_KEY } = getResendEnv();
  const content = await fetchReceivedEmailContent(event.data.email_id, RESEND_API_KEY);
  const canonical = normalizeResendInboundEmail(event, content, mailboxAddress);

  const { recordInboundMessage, DuplicateInboundMessageError } =
    await import("@/server/services/inbox");
  try {
    const { duplicate } = await recordInboundMessage(orgId, {
      channel: "EMAIL",
      fromAddress: canonical.fromAddress,
      toAddress: canonical.mailboxAddress,
      subject: canonical.subject,
      body: canonical.text || "(no content)",
      externalId: canonical.providerMessageId,
    });
    return NextResponse.json({ ok: true, duplicate });
  } catch (err) {
    if (err instanceof DuplicateInboundMessageError) {
      return NextResponse.json({ error: { code: "conflict" } }, { status: 409 });
    }
    throw err;
  }
}
