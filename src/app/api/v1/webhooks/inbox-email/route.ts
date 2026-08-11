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
 * Inbound-email webhook. Accepts a normalized, provider-agnostic payload
 * (see `inboundEmailWebhookSchema`) rather than any specific ESP's raw
 * webhook JSON — mapping a real provider's payload shape and a recipient
 * address to an organization (instead of requiring `organizationId` in the
 * body) is a deliberate follow-up once an inbound provider is chosen.
 *
 * Fails closed: if `INBOX_EMAIL_WEBHOOK_SECRET` is not configured, every
 * request is rejected rather than accepted unauthenticated (§4).
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

  const { rateLimiters } = await import("@/server/integrations/redis");
  const rateLimit = await rateLimiters.inboxEmailWebhook.limit(input.organizationId);
  if (!rateLimit.success) {
    return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
  }

  const { recordInboundMessage, DuplicateInboundMessageError } =
    await import("@/server/services/inbox");
  try {
    const { duplicate } = await recordInboundMessage(input.organizationId, {
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
