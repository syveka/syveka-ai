import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public token-gated booking management.
 * GET → booking details, POST → reschedule, DELETE → cancel.
 * Tokens are single-purpose, hashed at rest and expiring; every route is
 * rate-limited per IP to stop token brute-forcing.
 *
 * Every limit fails closed: when it can't be verified (Redis timed out or
 * errored) the request is refused (503) before the token is looked up, so an
 * outage can't be used to guess tokens or change a booking unchecked.
 */

async function deps() {
  const [rateLimit, booking, tokens, validators, notifications, reminders] = await Promise.all([
    import("@/server/security/rate-limit"),
    import("@/server/services/booking"),
    import("@/server/services/booking-tokens"),
    import("@/lib/validators/booking"),
    import("@/server/services/booking-notifications"),
    import("@/server/services/reminders"),
  ]);
  return { rateLimit, booking, tokens, validators, notifications, reminders };
}

function limitKey(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  return `booking-manage:${ip}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { rateLimit, booking, tokens } = await deps();
  const refused = await rateLimit.rateLimitRefusal("api", limitKey(request));
  if (refused) return refused;

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
  const { rateLimit, booking, tokens, validators, notifications, reminders } = await deps();
  const refused = await rateLimit.rateLimitRefusal("auth", limitKey(request));
  if (refused) return refused;

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
    const [notified] = await Promise.allSettled([
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
      // "skipped" means the email was already claimed (sent or in flight).
      confirmationEmailSent:
        notified.status === "fulfilled" && notified.value.guestEmail !== "failed",
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
  const { rateLimit, booking, tokens, validators, notifications } = await deps();
  const refused = await rateLimit.rateLimitRefusal("auth", limitKey(request));
  if (refused) return refused;

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
