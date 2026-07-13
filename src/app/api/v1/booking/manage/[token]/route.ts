import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public token-gated booking management.
 * GET → booking details, POST → reschedule, DELETE → cancel.
 * Tokens are single-purpose, hashed at rest and expiring; every route is
 * rate-limited per IP to stop token brute-forcing.
 */

async function deps() {
  const [redis, booking, tokens, validators, notifications, reminders] = await Promise.all([
    import("@/server/integrations/redis"),
    import("@/server/services/booking"),
    import("@/server/services/booking-tokens"),
    import("@/lib/validators/booking"),
    import("@/server/services/booking-notifications"),
    import("@/server/services/reminders"),
  ]);
  return { redis, booking, tokens, validators, notifications, reminders };
}

function limitKey(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  return `booking-manage:${ip}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { redis, booking, tokens } = await deps();
  const { success } = await redis.rateLimiters.api.limit(limitKey(request));
  if (!success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { token } = await params;
  try {
    const b = await booking.getBookingByToken(token);
    return NextResponse.json({
      bookingType: { name: b.bookingType.name, location: b.bookingType.location },
      status: b.status,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      guestName: b.guestName,
      guestTimezone: b.guestTimezone,
    });
  } catch (e) {
    if (e instanceof tokens.BookingTokenError) {
      return NextResponse.json({ error: e.code }, { status: 404 });
    }
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { redis, booking, tokens, validators, notifications, reminders } = await deps();
  const { success } = await redis.rateLimiters.auth.limit(limitKey(request));
  if (!success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = validators.publicRescheduleSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const { token } = await params;
  try {
    const result = await booking.rescheduleBookingViaToken(token, parsed.data.startsAt);
    await Promise.allSettled([
      notifications.sendBookingLifecycleNotifications({
        kind: "reschedule",
        bookingId: result.booking.id,
        manageToken: result.manageToken,
      }),
      reminders.scheduleEventReminders({
        orgId: result.booking.organizationId,
        eventId: result.event.id,
        startsAt: result.booking.startsAt,
      }),
    ]);
    return NextResponse.json({
      bookingId: result.booking.id,
      manageToken: result.manageToken,
      startsAt: result.booking.startsAt.toISOString(),
    });
  } catch (e) {
    if (e instanceof tokens.BookingTokenError) {
      return NextResponse.json({ error: e.code }, { status: 404 });
    }
    if (e instanceof booking.BookingError) {
      const status = e.code === "slot_taken" ? 409 : 400;
      return NextResponse.json({ error: e.code }, { status });
    }
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { redis, booking, tokens, validators, notifications } = await deps();
  const { success } = await redis.rateLimiters.auth.limit(limitKey(request));
  if (!success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let reason: string | undefined;
  try {
    const body: unknown = await request.json();
    const parsed = validators.publicCancelSchema.safeParse(body);
    if (parsed.success) reason = parsed.data.reason;
  } catch {
    reason = undefined; // body optional for cancel
  }

  const { token } = await params;
  try {
    const canceled = await booking.cancelBookingViaToken(token, reason);
    await notifications
      .sendBookingLifecycleNotifications({ kind: "cancellation", bookingId: canceled.id })
      .catch(() => undefined);
    return NextResponse.json({ status: "canceled" });
  } catch (e) {
    if (e instanceof tokens.BookingTokenError) {
      return NextResponse.json({ error: e.code }, { status: 404 });
    }
    if (e instanceof booking.BookingError) {
      return NextResponse.json({ error: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
