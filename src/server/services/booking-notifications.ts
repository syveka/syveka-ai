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
  const intlLocale = locale === "ar" ? "ar" : locale === "fi" ? "fi" : "en";
  const fmt = new Intl.DateTimeFormat(intlLocale, {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
  const end = new Intl.DateTimeFormat(intlLocale, {
    timeZone: timezone,
    timeStyle: "short",
  });
  return `${fmt.format(startsAt)} – ${end.format(endsAt)} (${timezone})`;
}

/**
 * The owner's in-app notification names what happened first, so the list
 * reads "New booking: Intro call — Anna" rather than just the meeting name.
 * Stored text, written in the owner's own language when the row is created;
 * rows written earlier keep the wording they had.
 */
const OWNER_NOTIFICATION_ACTIONS: Record<BookingEmailLocale, Record<BookingEmailKind, string>> = {
  en: {
    confirmation: "New booking",
    reschedule: "Booking rescheduled",
    cancellation: "Booking canceled",
    reminder: "Upcoming meeting",
  },
  fi: {
    confirmation: "Uusi varaus",
    reschedule: "Varaus siirretty",
    cancellation: "Varaus peruttu",
    reminder: "Tuleva tapaaminen",
  },
  ar: {
    confirmation: "حجز جديد",
    reschedule: "تمت إعادة جدولة الحجز",
    cancellation: "تم إلغاء الحجز",
    reminder: "اجتماع قادم",
  },
};

function toNotificationLocale(locale: string | null | undefined): BookingEmailLocale {
  return locale === "FI" ? "fi" : locale === "AR" ? "ar" : "en";
}

export function ownerNotificationTitle(
  kind: BookingEmailKind,
  locale: BookingEmailLocale,
  bookingTypeName: string,
  guestName: string,
): string {
  return `${OWNER_NOTIFICATION_ACTIONS[locale][kind]}: ${bookingTypeName} — ${guestName}`;
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
    select: { id: true, email: true, timezone: true, locale: true },
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

    // In the owner's language and zone (the guest's may differ); for a
    // reschedule this is the new time.
    const ownerLocale = toNotificationLocale(owner.locale);
    await once(keyFor("in-app"), params.kind, "owner_notification", booking.id, () =>
      unscopedPrisma.notification.create({
        data: {
          organizationId: booking.organizationId,
          userId: owner.id,
          type: `booking.${params.kind}`,
          title: ownerNotificationTitle(
            params.kind,
            ownerLocale,
            booking.bookingType.name,
            booking.guestName,
          ),
          body: formatWhen(booking.startsAt, booking.endsAt, owner.timezone, ownerLocale),
          href: "/calendar",
        },
      }),
    );
  }

  return { guestEmail };
}
