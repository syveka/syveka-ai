import { NextResponse } from "next/server";
import { z } from "zod";
import { jobPayloadJson } from "@/server/jobs/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const payloadSchema = z.object({ reminderId: z.string().guid() });

/**
 * QStash job: deliver a meeting reminder.
 * Idempotent: the Reminder row is flipped SCHEDULED → SENT with a guarded
 * updateMany before any email goes out, so QStash retries and duplicate
 * deliveries can never double-send.
 *
 * Delivery failures are never silent: each is logged (ids and the error's
 * name only), and a reminder that reached nobody is recorded as FAILED and
 * answered with 500, so QStash retries it; the claim below accepts FAILED
 * again for that reason. A reminder that reached some recipients stays SENT
 * (nothing is ever sent twice) with the failures logged.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { unscopedPrisma }, { sendEmail }, emailMod, guard] =
    await Promise.all([
      import("@/server/jobs/verify"),
      import("@/server/db/tenant"),
      import("@/server/integrations/resend"),
      import("../../../../../../emails/booking-email"),
      import("@/server/jobs/organization-guard"),
    ]);

  const body = await verifyJobRequest(request);
  if (body === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(jobPayloadJson(body));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  // A reminder of a missing or soft-deleted organization is left as it is
  // and nothing is sent. (An unknown reminder falls through to the claim,
  // which matches nothing.)
  const owner = await unscopedPrisma.reminder.findUnique({
    where: { id: parsed.data.reminderId },
    select: { organizationId: true },
  });
  if (owner && !(await guard.isOrganizationActive(owner.organizationId))) {
    return NextResponse.json(guard.ORGANIZATION_INACTIVE);
  }

  // Claim the reminder atomically; 0 rows → already handled or canceled.
  // FAILED (nothing was delivered) is claimable again, so a retry can send.
  const claimed = await unscopedPrisma.reminder.updateMany({
    where: { id: parsed.data.reminderId, status: { in: ["SCHEDULED", "FAILED"] } },
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
          organization: { select: { name: true, deletedAt: true } },
        },
      },
    },
  });
  const event = reminder?.event;
  if (!reminder || !event || event.status === "CANCELED" || event.deletedAt) {
    return NextResponse.json({ skipped: true });
  }
  // Deleted after the check above: same as a canceled event (nothing sent).
  if (event.organization.deletedAt || event.organizationId !== reminder.organizationId) {
    return NextResponse.json(guard.ORGANIZATION_INACTIVE);
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

    let sent = 0;
    let lastErrorName = "unknown";
    for (const to of recipients) {
      try {
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
        });
        sent += 1;
      } catch (e) {
        // Never the recipient address or the provider's message: ids and the
        // error's name are enough to see a delivery problem in the logs.
        lastErrorName = e instanceof Error ? e.name : "unknown";
        console.error(
          JSON.stringify({
            event: "reminder_email_failed",
            reminderId: reminder.id,
            eventId: event.id,
            orgId: reminder.organizationId,
            name: lastErrorName,
          }),
        );
      }
    }
    const failed = recipients.size - sent;
    if (failed > 0 && sent === 0) {
      // Nobody was reached: not SENT. Recorded, and retried by QStash (500).
      await unscopedPrisma.reminder.update({
        where: { id: reminder.id },
        data: { status: "FAILED", lastError: `email delivery failed: ${lastErrorName}` },
      });
      return NextResponse.json({ error: "send failed", sent, failed }, { status: 500 });
    }
    return NextResponse.json({ sent, failed });
  } catch (e) {
    await unscopedPrisma.reminder.update({
      where: { id: reminder.id },
      data: { status: "FAILED", lastError: e instanceof Error ? e.message : "send failed" },
    });
    return NextResponse.json({ error: "send failed" }, { status: 500 });
  }
}
