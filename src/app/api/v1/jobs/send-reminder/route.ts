import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jobPayloadJson } from "@/server/jobs/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const payloadSchema = z.object({ reminderId: z.string().guid() });

/**
 * Resend's Idempotency-Key for one reminder to one recipient: the same on
 * every retry of this reminder row, different for every other row (a moved
 * event gets new rows) and recipient. The address is hashed, so the key stays
 * within Resend's 256 characters and doesn't carry it.
 */
function reminderEmailIdempotencyKey(reminderId: string, to: string): string {
  return `reminder-${reminderId}-${createHash("sha256").update(to).digest("hex")}`;
}

/**
 * Resend's answer when this key was already used with a different payload:
 * the event's title, place or organization name changed between attempts.
 * Sending again could duplicate an email the provider already accepted, and
 * a retry would only get the same answer, so the recipient is left as is.
 */
function isIdempotencyConflict(e: unknown): boolean {
  return (
    e instanceof Error &&
    e.name === "EmailSendError" &&
    (e as { code?: unknown }).code === "invalid_idempotent_request"
  );
}

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
 *
 * A thrown send doesn't prove nothing went out: Resend may have accepted it
 * and the answer been lost. Each send therefore carries a per-reminder,
 * per-recipient Idempotency-Key, so the retry of a FAILED reminder gets
 * Resend's original answer instead of a second email. Resend keeps keys for
 * 24 hours; QStash's automatic retries of a reminder end well within that. A
 * manual replay from the dead-letter queue after 24 hours is not covered.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [
    { verifyJobRequest },
    { unscopedPrisma },
    { sendEmail },
    emailMod,
    guard,
    { REMINDER_OFFSETS_MINUTES },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/integrations/resend"),
    import("../../../../../../emails/booking-email"),
    import("@/server/jobs/organization-guard"),
    import("@/server/services/reminders"),
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
  // Timed from another start time: the event moved after this reminder was
  // scheduled (a retry of a FAILED send can arrive after the move). Canceled,
  // never sent with the new time at the old lead.
  const leadMs = event.startsAt.getTime() - reminder.sendAt.getTime();
  if (!REMINDER_OFFSETS_MINUTES.some((minutes) => minutes * 60_000 === leadMs)) {
    await unscopedPrisma.reminder.update({
      where: { id: reminder.id },
      data: { status: "CANCELED" },
    });
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

    let sent = 0;
    let failed = 0;
    let notResent = 0;
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
          idempotencyKey: reminderEmailIdempotencyKey(reminder.id, to),
        });
        sent += 1;
      } catch (e) {
        // Never the recipient address or the provider's message: ids and the
        // error's name are enough to see a delivery problem in the logs.
        const conflict = isIdempotencyConflict(e);
        if (conflict) {
          notResent += 1;
        } else {
          failed += 1;
          lastErrorName = e instanceof Error ? e.name : "unknown";
        }
        console.error(
          JSON.stringify({
            event: conflict ? "reminder_email_not_resent" : "reminder_email_failed",
            reminderId: reminder.id,
            eventId: event.id,
            orgId: reminder.organizationId,
            name: e instanceof Error ? e.name : "unknown",
          }),
        );
      }
    }
    if (failed > 0 && sent === 0) {
      // Nobody was reached: not SENT. Recorded, and retried by QStash (500).
      await unscopedPrisma.reminder.update({
        where: { id: reminder.id },
        data: { status: "FAILED", lastError: `email delivery failed: ${lastErrorName}` },
      });
      return NextResponse.json({ error: "send failed", sent, failed }, { status: 500 });
    }
    if (notResent > 0 && sent === 0) {
      // Whether anyone was reached is unknown: kept SENT (not retried), but
      // the row says so instead of keeping an earlier attempt's error. Best
      // effort: a failed note must not turn this decision into a retry.
      await unscopedPrisma.reminder
        .update({
          where: { id: reminder.id },
          data: { lastError: "email not resent: idempotency conflict" },
        })
        .catch((e: unknown) =>
          console.error(
            JSON.stringify({
              event: "reminder_note_failed",
              reminderId: reminder.id,
              name: e instanceof Error ? e.name : "unknown",
            }),
          ),
        );
    }
    return NextResponse.json(notResent > 0 ? { sent, failed, notResent } : { sent, failed });
  } catch (e) {
    await unscopedPrisma.reminder.update({
      where: { id: reminder.id },
      data: { status: "FAILED", lastError: e instanceof Error ? e.message : "send failed" },
    });
    return NextResponse.json({ error: "send failed" }, { status: 500 });
  }
}
