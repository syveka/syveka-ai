import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const payloadSchema = z.object({ reminderId: z.string().uuid() });

/**
 * QStash job: deliver a meeting reminder.
 * Idempotent: the Reminder row is flipped SCHEDULED → SENT with a guarded
 * updateMany before any email goes out, so QStash retries and duplicate
 * deliveries can never double-send.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { unscopedPrisma }, { sendEmail }, emailMod] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/integrations/resend"),
    import("../../../../../../emails/booking-email"),
  ]);

  const body = await verifyJobRequest(request);
  if (body === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  // Claim the reminder atomically; 0 rows → already handled or canceled.
  const claimed = await unscopedPrisma.reminder.updateMany({
    where: { id: parsed.data.reminderId, status: "SCHEDULED" },
    data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return NextResponse.json({ skipped: true });

  const reminder = await unscopedPrisma.reminder.findUnique({
    where: { id: parsed.data.reminderId },
    include: {
      event: {
        include: {
          attendeeRecords: { select: { email: true, name: true } },
          booking: {
            select: { guestEmail: true, guestName: true, guestTimezone: true, guestLocale: true },
          },
          organization: { select: { name: true } },
        },
      },
    },
  });
  const event = reminder?.event;
  if (!reminder || !event || event.status === "CANCELED" || event.deletedAt) {
    return NextResponse.json({ skipped: true });
  }

  try {
    const timezone = event.booking?.guestTimezone ?? event.timezone;
    const locale =
      event.booking?.guestLocale === "FI"
        ? ("fi" as const)
        : event.booking?.guestLocale === "AR"
          ? ("ar" as const)
          : ("en" as const);
    const whenText = new Intl.DateTimeFormat(
      locale === "fi" ? "fi" : locale === "ar" ? "ar" : "en",
      {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "short",
      },
    ).format(event.startsAt);

    const recipients = new Set<string>();
    if (event.booking?.guestEmail) recipients.add(event.booking.guestEmail);
    for (const a of event.attendeeRecords) if (a.email) recipients.add(a.email);

    for (const to of recipients) {
      await sendEmail({
        to,
        subject: emailMod.bookingEmailSubject("reminder", locale, event.title),
        react: emailMod.BookingEmail({
          kind: "reminder",
          locale,
          title: event.title,
          organizationName: event.organization.name,
          whenText: `${whenText} (${timezone})`,
          whereText: event.location ?? undefined,
        }),
      }).catch(() => undefined);
    }
    return NextResponse.json({ sent: recipients.size });
  } catch (e) {
    await unscopedPrisma.reminder.update({
      where: { id: reminder.id },
      data: { status: "FAILED", lastError: e instanceof Error ? e.message : "send failed" },
    });
    return NextResponse.json({ error: "send failed" }, { status: 500 });
  }
}
