import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Thrown from the admission check to stop the booking; the route answers with the refusal. */
class AdmissionRefused extends Error {}

/**
 * Public: create a booking. Abuse controls: strict per-IP rate limit,
 * Zod validation, honeypot field, consent enforcement, availability
 * re-validation inside a transaction (double-booking safe).
 *
 * The rate limit fails closed: when it can't be verified (Redis timed out or
 * errored) nothing is booked, emailed or scheduled (503).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ org: string; slug: string }> },
) {
  const [
    { rateLimitRefusal, emailKey },
    { createPublicBooking, BookingError },
    { publicBookingSchema },
    { sendBookingLifecycleNotifications },
    { scheduleEventReminders },
  ] = await Promise.all([
    import("@/server/security/rate-limit"),
    import("@/server/services/booking"),
    import("@/lib/validators/booking"),
    import("@/server/services/booking-notifications"),
    import("@/server/services/reminders"),
  ]);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const refused = await rateLimitRefusal("auth", `booking-create:${ip}`);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = publicBookingSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const { org, slug } = await params;
  // Each booking emails the address the guest typed. Beyond the per-IP limit,
  // a guest address (per organization) and a booking page are capped whatever
  // the IP, so the page can't be used to mail strangers or fill the owner's
  // calendar. Checked by the service once the slot is known to be bookable
  // and before anything is written or sent: only attempts that would book
  // count, so junk requests can't switch a page or a guest off.
  let refusal: NextResponse | null = null;
  const admit = async (bookingType: { id: string; organizationId: string }) => {
    refusal =
      (await rateLimitRefusal(
        "publicBookingRecipient",
        `${bookingType.organizationId}:${emailKey(parsed.data.email)}`,
      )) ?? (await rateLimitRefusal("publicBookingType", bookingType.id));
    if (refusal) throw new AdmissionRefused();
  };

  try {
    const result = await createPublicBooking({
      orgSlug: org,
      typeSlug: slug,
      input: parsed.data,
      admit,
    });

    // Side effects never fail the booking, but the guest is told whether the
    // confirmation email actually left (a retry of a failed send can still
    // deliver it: its idempotency claim is released on failure).
    const [notified] = await Promise.allSettled([
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
      // "skipped" means the email was already claimed (sent or in flight).
      confirmationEmailSent:
        notified.status === "fulfilled" && notified.value.guestEmail !== "failed",
    });
  } catch (e) {
    if (e instanceof AdmissionRefused && refusal) return refusal;
    if (e instanceof BookingError) {
      if (e.code === "calendar_busy") {
        return NextResponse.json(
          { error: e.code },
          { status: 503, headers: { "Retry-After": "2" } },
        );
      }
      const status = e.code === "not_found" ? 404 : e.code === "slot_taken" ? 409 : 400;
      return NextResponse.json({ error: e.code }, { status });
    }
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
