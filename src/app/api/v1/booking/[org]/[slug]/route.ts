import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public: create a booking. Abuse controls: strict per-IP rate limit,
 * Zod validation, honeypot field, consent enforcement, availability
 * re-validation inside a transaction (double-booking safe).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ org: string; slug: string }> },
) {
  const [
    { rateLimiters },
    { createPublicBooking, BookingError },
    { publicBookingSchema },
    { sendBookingLifecycleNotifications },
    { scheduleEventReminders },
  ] = await Promise.all([
    import("@/server/integrations/redis"),
    import("@/server/services/booking"),
    import("@/lib/validators/booking"),
    import("@/server/services/booking-notifications"),
    import("@/server/services/reminders"),
  ]);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const { success } = await rateLimiters.auth.limit(`booking-create:${ip}`);
  if (!success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = publicBookingSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const { org, slug } = await params;
  try {
    const result = await createPublicBooking({ orgSlug: org, typeSlug: slug, input: parsed.data });

    // Fire-and-forget side effects (never fail the booking).
    await Promise.allSettled([
      sendBookingLifecycleNotifications({
        kind: "confirmation",
        bookingId: result.booking.id,
        manageToken: result.manageToken,
      }),
      scheduleEventReminders({
        orgId: result.booking.organizationId,
        eventId: result.event.id,
        startsAt: result.booking.startsAt,
      }),
    ]);

    return NextResponse.json({
      bookingId: result.booking.id,
      manageToken: result.manageToken,
      startsAt: result.booking.startsAt.toISOString(),
      endsAt: result.booking.endsAt.toISOString(),
      confirmationMessage: result.bookingType.confirmationMessage,
    });
  } catch (e) {
    if (e instanceof BookingError) {
      const status = e.code === "not_found" ? 404 : e.code === "slot_taken" ? 409 : 400;
      return NextResponse.json({ error: e.code }, { status });
    }
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
