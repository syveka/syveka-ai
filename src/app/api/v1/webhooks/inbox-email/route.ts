import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { inboundEmailWebhookSchema } from "@/lib/validators/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Constant-time shared-secret check (§13.2 pattern) — never short-circuit on length. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Provider-agnostic inbound-email webhook. Accepts a normalized payload
 * (see `inboundEmailWebhookSchema`) rather than any specific ESP's raw
 * webhook JSON — the real Resend adapter lives at
 * `/api/v1/webhooks/inbox-email/resend` and normalizes into this same
 * shape before calling the shared service function. This endpoint stays
 * useful for manual testing, fixtures, and any future provider that can
 * emit the normalized shape directly.
 *
 * Fails closed twice, independently:
 * - if `INBOX_EMAIL_WEBHOOK_SECRET` is not configured, every request is
 *   rejected rather than accepted unauthenticated (§4)
 * - the organization is NEVER read from the request body — it is resolved
 *   server-side from `toAddress` via the `inbox_mailboxes` table, so a
 *   valid secret alone can never inject a message into an arbitrary
 *   organization
 */
export async function POST(request: Request) {
  const expectedSecret = process.env.INBOX_EMAIL_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json({ error: { code: "not_configured" } }, { status: 503 });
  }

  const presented = request.headers.get("x-inbox-webhook-secret");
  if (!presented || !secretMatches(presented, expectedSecret)) {
    return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  const body = inboundEmailWebhookSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: { code: "invalid_input", details: body.error.flatten() } },
      { status: 400 },
    );
  }
  const input = body.data;

  const { resolveOrgIdByMailboxAddress } = await import("@/server/services/inbox-mailbox");
  const orgId = await resolveOrgIdByMailboxAddress(input.toAddress, "EMAIL");
  if (!orgId) {
    // Deliberately identical response to a bad secret: never confirm or
    // deny whether an address is registered to anyone.
    return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  const { rateLimiters } = await import("@/server/integrations/redis");
  const rateLimit = await rateLimiters.inboxEmailWebhook.limit(orgId);
  if (!rateLimit.success) {
    return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
  }

  const { recordInboundMessage, DuplicateInboundMessageError } =
    await import("@/server/services/inbox");
  try {
    const { duplicate } = await recordInboundMessage(orgId, {
      channel: "EMAIL",
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      subject: input.subject,
      body: input.body,
      externalId: input.externalId,
    });
    return NextResponse.json({ ok: true, duplicate });
  } catch (err) {
    if (err instanceof DuplicateInboundMessageError) {
      // externalId collision across organizations: extremely unlikely with real
      // provider message ids, but never silently attribute it to the wrong tenant.
      return NextResponse.json({ error: { code: "conflict" } }, { status: 409 });
    }
    throw err;
  }
}
