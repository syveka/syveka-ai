import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { sendEmail } from "@/server/integrations/resend";
import { seenIdempotencyKey } from "@/server/integrations/redis";
import { clientEnv } from "@/env";
import {
  BookingEmail,
  bookingEmailSubject,
  type BookingEmailKind,
  type BookingEmailLocale,
} from "../../../emails/booking-email";

/**
 * Booking lifecycle notifications: guest email + owner email + in-app row.
 * Every send is guarded by a Redis idempotency key (booking id + kind), so
 * retried actions and QStash redeliveries never double-notify. All failures
 * are swallowed by the callers — notifications must not break bookings.
 */

function formatWhen(startsAt: Date, endsAt: Date, timezone: string, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale === "ar" ? "ar" : locale === "fi" ? "fi" : "en", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
  const end = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeStyle: "short",
  });
  return `${fmt.format(startsAt)} – ${end.format(endsAt)} (${timezone})`;
}

export async function sendBookingLifecycleNotifications(params: {
  kind: BookingEmailKind;
  bookingId: string;
  manageToken?: string;
}): Promise<void> {
  const booking = await unscopedPrisma.booking.findUnique({
    where: { id: params.bookingId },
    include: {
      bookingType: {
        select: { name: true, location: true, confirmationMessage: true, ownerId: true },
      },
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!booking) return;

  const idemKey = `booking-notify:${booking.id}:${params.kind}`;
  if (await seenIdempotencyKey(idemKey)) return;

  const locale: BookingEmailLocale =
    booking.guestLocale === "FI" ? "fi" : booking.guestLocale === "AR" ? "ar" : "en";
  const manageUrl = params.manageToken
    ? `${clientEnv.NEXT_PUBLIC_APP_URL}/booking/manage/${params.manageToken}`
    : undefined;

  const whenText = formatWhen(booking.startsAt, booking.endsAt, booking.guestTimezone, locale);

  // Guest email (in the guest's locale).
  await sendEmail({
    to: booking.guestEmail,
    subject: bookingEmailSubject(params.kind, locale, booking.bookingType.name),
    react: BookingEmail({
      kind: params.kind,
      locale,
      title: booking.bookingType.name,
      organizationName: booking.organization.name,
      whenText,
      whereText: booking.bookingType.location ?? undefined,
      manageUrl,
      message:
        params.kind === "confirmation"
          ? (booking.bookingType.confirmationMessage ?? undefined)
          : undefined,
    }),
  }).catch(() => undefined);

  // Internal attendee (owner) email + in-app notification.
  const owner = await unscopedPrisma.user.findUnique({
    where: { id: booking.bookingType.ownerId },
    select: { id: true, email: true, timezone: true },
  });
  if (owner) {
    const ownerWhen = formatWhen(booking.startsAt, booking.endsAt, owner.timezone, "en");
    await sendEmail({
      to: owner.email,
      subject: bookingEmailSubject(params.kind, "en", booking.bookingType.name),
      react: BookingEmail({
        kind: params.kind,
        locale: "en",
        title: `${booking.bookingType.name} — ${booking.guestName}`,
        organizationName: booking.organization.name,
        whenText: ownerWhen,
        whereText: booking.bookingType.location ?? undefined,
      }),
    }).catch(() => undefined);

    await unscopedPrisma.notification
      .create({
        data: {
          organizationId: booking.organizationId,
          userId: owner.id,
          type: `booking.${params.kind}`,
          title: `${booking.bookingType.name} — ${booking.guestName}`,
          body: whenText,
          href: "/calendar",
        },
      })
      .catch(() => undefined);
  }
}
