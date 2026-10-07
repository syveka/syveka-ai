import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { EmailSendError, sendEmail } from "@/server/integrations/resend";
import { releaseIdempotencyKey, seenIdempotencyKey } from "@/server/integrations/redis";
import { getAppUrlEnv } from "@/env";
import {
  BookingEmail,
  bookingEmailSubject,
  type BookingEmailKind,
  type BookingEmailLocale,
} from "../../../emails/booking-email";

/**
 * Booking lifecycle notifications: guest email + owner email + in-app row.
 * Each of the three is guarded by its own Redis claim (booking id + kind +
 * part), so retried actions and QStash redeliveries never double-notify. A
 * claim is given back when its send fails, so a retry can still deliver it
 * instead of skipping it as done; the same key goes to Resend as its
 * Idempotency-Key. Failures never break the booking, but they are logged
 * (with a reason code, never an address or token) and reported to the caller.
 */

export type GuestEmailOutcome = "sent" | "failed" | "skipped";

/** A safe, actionable reason: never the provider's message (it can quote addresses). */
function failureReason(error: unknown): string {
  if (error instanceof EmailSendError) return `provider:${error.code}`;
  if (error instanceof Error && error.message.startsWith("Invalid Resend environment variables")) {
    return "provider_not_configured";
  }
  return "unexpected";
}

function logNotificationFailure(
  kind: BookingEmailKind,
  part: "guest_email" | "owner_email" | "owner_notification",
  bookingId: string,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event: "booking_notification_failed",
      kind,
      part,
      bookingId,
      reason: failureReason(error),
    }),
  );
}

/** Runs one notification part at most once; a failure releases its claim. */
async function once(
  key: string,
  kind: BookingEmailKind,
  part: "guest_email" | "owner_email" | "owner_notification",
  bookingId: string,
  send: () => Promise<unknown>,
): Promise<"sent" | "failed" | "skipped"> {
  if (await seenIdempotencyKey(key)) return "skipped";
  try {
    await send();
    return "sent";
  } catch (error) {
    logNotificationFailure(kind, part, bookingId, error);
    await releaseIdempotencyKey(key).catch(() => undefined);
    return "failed";
  }
}

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
}): Promise<{ guestEmail: GuestEmailOutcome }> {
  const booking = await unscopedPrisma.booking.findUnique({
    where: { id: params.bookingId },
    include: {
      bookingType: {
        select: { name: true, location: true, confirmationMessage: true, ownerId: true },
      },
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!booking) return { guestEmail: "skipped" };

  const keyFor = (part: string) => `booking-notify:${booking.id}:${params.kind}:${part}`;

  const locale: BookingEmailLocale =
    booking.guestLocale === "FI" ? "fi" : booking.guestLocale === "AR" ? "ar" : "en";
  const manageUrl = params.manageToken
    ? `${getAppUrlEnv().NEXT_PUBLIC_APP_URL}/booking/manage/${params.manageToken}`
    : undefined;

  const whenText = formatWhen(booking.startsAt, booking.endsAt, booking.guestTimezone, locale);

  // Guest email (in the guest's locale).
  const guestKey = keyFor("guest");
  const guestEmail = await once(guestKey, params.kind, "guest_email", booking.id, () =>
    sendEmail({
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
      idempotencyKey: guestKey,
    }),
  );

  // Internal attendee (owner) email + in-app notification.
  const owner = await unscopedPrisma.user.findUnique({
    where: { id: booking.bookingType.ownerId },
    select: { id: true, email: true, timezone: true },
  });
  if (owner) {
    const ownerWhen = formatWhen(booking.startsAt, booking.endsAt, owner.timezone, "en");
    const ownerKey = keyFor("owner");
    await once(ownerKey, params.kind, "owner_email", booking.id, () =>
      sendEmail({
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
        idempotencyKey: ownerKey,
      }),
    );

    await once(keyFor("in-app"), params.kind, "owner_notification", booking.id, () =>
      unscopedPrisma.notification.create({
        data: {
          organizationId: booking.organizationId,
          userId: owner.id,
          type: `booking.${params.kind}`,
          title: `${booking.bookingType.name} — ${booking.guestName}`,
          body: whenText,
          href: "/calendar",
        },
      }),
    );
  }

  return { guestEmail };
}
