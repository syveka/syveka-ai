import "server-only";

import { Prisma } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { audit } from "./audit";
import { emitWorkflowEvent } from "./workflow-events";
import { issueToken, invalidateBookingTokens } from "./booking-tokens";
import {
  computeAvailableSlots,
  type BusyInterval,
  type DateOverride,
  type WeeklyRule,
} from "@/server/calendar/slots";
import { isValidTimezone } from "@/server/calendar/timezone";
import type { TenantContext } from "@/server/auth/session";
import type { BookingTypeInput, PublicBookingInput } from "@/lib/validators/booking";

export class BookingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "inactive"
      | "slug_taken"
      | "invalid_timezone"
      | "invalid_duration"
      | "invalid_relation"
      | "consent_required"
      | "slot_taken"
      | "invalid_slot"
      | "too_late"
      | "already_canceled",
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/** Built-in fallback: Mon–Fri 09:00–17:00 in the schedule/org timezone. */
export const DEFAULT_WEEKLY_RULES: WeeklyRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));

// ── Booking type management (tenant side) ────────────────────────────────

export async function listBookingTypes(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.bookingType.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: { schedule: { select: { id: true, name: true, timezone: true } } },
    take: 100,
  });
}

export async function getBookingType(ctx: TenantContext, id: string) {
  const db = tenantDb(ctx.orgId);
  return db.bookingType.findFirst({
    where: { id, deletedAt: null },
    include: { schedule: { select: { id: true, name: true, timezone: true } } },
  });
}

export async function saveBookingType(
  ctx: TenantContext,
  input: BookingTypeInput,
  bookingTypeId?: string,
) {
  const db = tenantDb(ctx.orgId);
  if (input.scheduleId) {
    const schedule = await db.availabilitySchedule.findFirst({
      where: { id: input.scheduleId },
      select: { id: true },
    });
    if (!schedule) throw new BookingError("Schedule not in organization", "invalid_relation");
  }

  const durationOptions =
    input.durationOptions.length > 0 ? input.durationOptions : [input.durationMinutes];
  if (!durationOptions.includes(input.durationMinutes)) {
    durationOptions.unshift(input.durationMinutes);
  }

  const data = {
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    durationMinutes: input.durationMinutes,
    durationOptions,
    locationType: input.locationType,
    location: input.location ?? null,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    minNoticeMinutes: input.minNoticeMinutes,
    maxWindowDays: input.maxWindowDays,
    brandColor: input.brandColor ?? null,
    confirmationMessage: input.confirmationMessage ?? null,
    collectPhone: input.collectPhone,
    collectCompany: input.collectCompany,
    requiresConsent: input.requiresConsent,
    isActive: input.isActive,
    scheduleId: input.scheduleId ?? null,
  };

  try {
    const result = bookingTypeId
      ? await db.bookingType.update({ where: { id: bookingTypeId }, data })
      : await db.bookingType.create({
          data: { ...data, organizationId: ctx.orgId, ownerId: ctx.userId },
        });
    await audit(ctx, {
      action: bookingTypeId ? "booking_type.update" : "booking_type.create",
      resourceType: "booking_type",
      resourceId: result.id,
      after: { slug: input.slug, name: input.name },
    });
    return result;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new BookingError("Slug already in use", "slug_taken");
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      throw new BookingError("Booking type not found", "not_found");
    }
    throw e;
  }
}

export async function deleteBookingType(ctx: TenantContext, id: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const existing = await db.bookingType.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, slug: true },
  });
  if (!existing) throw new BookingError("Booking type not found", "not_found");
  await db.bookingType.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
  await audit(ctx, {
    action: "booking_type.delete",
    resourceType: "booking_type",
    resourceId: id,
    before: { slug: existing.slug },
  });
}

export async function listBookings(ctx: TenantContext, opts?: { upcomingOnly?: boolean }) {
  const db = tenantDb(ctx.orgId);
  return db.booking.findMany({
    where: opts?.upcomingOnly ? { startsAt: { gte: new Date() }, status: "CONFIRMED" } : {},
    orderBy: { startsAt: "desc" },
    include: { bookingType: { select: { id: true, name: true, slug: true } } },
    take: 200,
  });
}

// ── Public booking path (no session; org resolved from the URL) ──────────

type PublicBookingType = NonNullable<Awaited<ReturnType<typeof getPublicBookingType>>>;

/** Public, unauthenticated: resolves an active booking type by org + slug. */
export async function getPublicBookingType(orgSlug: string, typeSlug: string) {
  const bookingType = await unscopedPrisma.bookingType.findFirst({
    where: {
      slug: typeSlug,
      isActive: true,
      deletedAt: null,
      organization: { slug: orgSlug, deletedAt: null },
    },
    include: {
      organization: { select: { id: true, name: true, slug: true, logoUrl: true } },
      schedule: { include: { rules: true, overrides: true } },
    },
  });
  return bookingType;
}

async function resolveScheduleParts(bookingType: PublicBookingType): Promise<{
  timezone: string;
  rules: WeeklyRule[];
  overrides: DateOverride[];
}> {
  let schedule = bookingType.schedule;
  if (!schedule) {
    schedule = await unscopedPrisma.availabilitySchedule.findFirst({
      where: {
        organizationId: bookingType.organizationId,
        userId: bookingType.ownerId,
        isDefault: true,
      },
      include: { rules: true, overrides: true },
    });
  }
  if (!schedule) {
    return { timezone: "Europe/Helsinki", rules: DEFAULT_WEEKLY_RULES, overrides: [] };
  }
  return {
    timezone: schedule.timezone,
    rules: schedule.rules.map((r) => ({
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
    overrides: schedule.overrides.map((o) => ({
      date: o.date.toISOString().slice(0, 10),
      startMinute: o.startMinute,
      endMinute: o.endMinute,
      isUnavailable: o.isUnavailable,
    })),
  };
}

/** Owner busy intervals: their non-canceled events (bookings create events). */
async function getOwnerBusy(
  orgId: string,
  ownerId: string,
  from: Date,
  to: Date,
): Promise<BusyInterval[]> {
  const events = await unscopedPrisma.calendarEvent.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
      status: { not: "CANCELED" },
      OR: [{ ownerId }, { ownerId: null, createdById: ownerId }],
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    select: { startsAt: true, endsAt: true },
    take: 1000,
  });
  return events;
}

export async function getPublicSlots(params: {
  orgSlug: string;
  typeSlug: string;
  from: Date;
  to: Date;
  durationMinutes?: number;
  now?: Date;
}): Promise<{ slots: Date[]; timezone: string; durationMinutes: number }> {
  const bookingType = await getPublicBookingType(params.orgSlug, params.typeSlug);
  if (!bookingType) throw new BookingError("Booking page not found", "not_found");

  const duration = params.durationMinutes ?? bookingType.durationMinutes;
  if (!bookingType.durationOptions.includes(duration)) {
    throw new BookingError("Duration not offered", "invalid_duration");
  }

  const now = params.now ?? new Date();
  const parts = await resolveScheduleParts(bookingType);
  const busy = await getOwnerBusy(
    bookingType.organizationId,
    bookingType.ownerId,
    new Date(params.from.getTime() - 86_400_000),
    new Date(params.to.getTime() + 86_400_000),
  );

  const slots = computeAvailableSlots({
    timezone: parts.timezone,
    rules: parts.rules,
    overrides: parts.overrides,
    busy,
    from: params.from,
    to: params.to,
    now,
    durationMinutes: duration,
    bufferBeforeMinutes: bookingType.bufferBeforeMinutes,
    bufferAfterMinutes: bookingType.bufferAfterMinutes,
    minNoticeMinutes: bookingType.minNoticeMinutes,
    maxWindowDays: bookingType.maxWindowDays,
  });
  return { slots, timezone: parts.timezone, durationMinutes: duration };
}

async function assertSlotStillFree(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerId: string,
  startsAt: Date,
  endsAt: Date,
  guardBefore: number,
  guardAfter: number,
  excludeEventId?: string,
): Promise<void> {
  const guardStart = new Date(startsAt.getTime() - guardBefore * 60_000);
  const guardEnd = new Date(endsAt.getTime() + guardAfter * 60_000);
  const conflict = await tx.calendarEvent.findFirst({
    where: {
      organizationId: orgId,
      deletedAt: null,
      status: { not: "CANCELED" },
      OR: [{ ownerId }, { ownerId: null, createdById: ownerId }],
      startsAt: { lt: guardEnd },
      endsAt: { gt: guardStart },
      ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
    },
    select: { id: true },
  });
  if (conflict) throw new BookingError("Slot no longer available", "slot_taken");
}

/**
 * Guest-facing booking creation. Double-booking protection: the requested
 * slot is validated against computed availability, then re-checked inside
 * the write transaction so two concurrent guests cannot both commit.
 */
export async function createPublicBooking(params: {
  orgSlug: string;
  typeSlug: string;
  input: PublicBookingInput;
}) {
  const { input } = params;
  const bookingType = await getPublicBookingType(params.orgSlug, params.typeSlug);
  if (!bookingType) throw new BookingError("Booking page not found", "not_found");
  if (!isValidTimezone(input.timezone)) {
    throw new BookingError("Unknown timezone", "invalid_timezone");
  }
  if (bookingType.requiresConsent && !input.consent) {
    throw new BookingError("Consent required", "consent_required");
  }

  const duration = input.durationMinutes ?? bookingType.durationMinutes;
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);

  // The requested instant must be one of the offered slots.
  const { slots } = await getPublicSlots({
    orgSlug: params.orgSlug,
    typeSlug: params.typeSlug,
    from: new Date(startsAt.getTime() - 86_400_000),
    to: new Date(endsAt.getTime() + 86_400_000),
    durationMinutes: duration,
  });
  if (!slots.some((s) => s.getTime() === startsAt.getTime())) {
    throw new BookingError("Requested time is not available", "invalid_slot");
  }

  const orgId = bookingType.organizationId;
  const guestLocale =
    input.locale === "en"
      ? "EN"
      : input.locale === "ar"
        ? "AR"
        : input.locale === "fi"
          ? "FI"
          : null;

  const created = await unscopedPrisma.$transaction(async (tx) => {
    await assertSlotStillFree(
      tx,
      orgId,
      bookingType.ownerId,
      startsAt,
      endsAt,
      bookingType.bufferBeforeMinutes,
      bookingType.bufferAfterMinutes,
    );

    const event = await tx.calendarEvent.create({
      data: {
        organizationId: orgId,
        createdById: bookingType.ownerId,
        ownerId: bookingType.ownerId,
        title: `${bookingType.name} — ${input.name}`,
        description: input.notes ?? null,
        location: bookingType.location ?? null,
        timezone: input.timezone,
        startsAt,
        endsAt,
        source: "BOOKING",
      },
    });

    const matchedContact = await tx.contact.findFirst({
      where: { organizationId: orgId, email: input.email, deletedAt: null },
      select: { id: true },
    });

    await tx.eventAttendee.create({
      data: {
        eventId: event.id,
        contactId: matchedContact?.id ?? null,
        email: input.email,
        name: input.name,
        status: "ACCEPTED",
      },
    });

    const booking = await tx.booking.create({
      data: {
        organizationId: orgId,
        bookingTypeId: bookingType.id,
        eventId: event.id,
        guestName: input.name,
        guestEmail: input.email,
        guestPhone: input.phone ?? null,
        guestCompany: input.company ?? null,
        guestNotes: input.notes ?? null,
        guestTimezone: input.timezone,
        guestLocale,
        consentAt: input.consent ? new Date() : null,
        startsAt,
        endsAt,
      },
    });

    await tx.activity.create({
      data: {
        organizationId: orgId,
        contactId: matchedContact?.id ?? null,
        type: "MEETING",
        subject: `Booking: ${bookingType.name}`,
        body: `${input.name} (${input.email}) booked ${bookingType.name}.`,
        dueAt: startsAt,
        metadata: { bookingId: booking.id, kind: "booked" },
      },
    });

    return { booking, event, contactId: matchedContact?.id ?? null };
  });

  const manageToken = await issueToken(created.booking.id, "MANAGE");

  await audit(
    { orgId, userId: bookingType.ownerId },
    {
      action: "booking.create",
      resourceType: "booking",
      resourceId: created.booking.id,
      actorType: "system",
      after: { guestEmail: input.email, startsAt: startsAt.toISOString() },
    },
  ).catch(() => undefined);

  await emitWorkflowEvent(orgId, "booking.created", {
    bookingId: created.booking.id,
    bookingType: bookingType.name,
    guestName: input.name,
    guestEmail: input.email,
    startsAt: startsAt.toISOString(),
  }).catch(() => undefined);

  return { ...created, manageToken, bookingType };
}

// ── Cancel / reschedule via secure tokens ────────────────────────────────

export async function getBookingByToken(raw: string) {
  const { resolveToken } = await import("./booking-tokens");
  const record = await resolveToken(raw, "MANAGE");
  return record.booking;
}

export async function cancelBookingViaToken(raw: string, reason?: string) {
  const { resolveToken, consumeToken } = await import("./booking-tokens");
  const record = await resolveToken(raw, "CANCEL");
  const booking = record.booking;

  if (booking.status === "CANCELED") {
    throw new BookingError("Already canceled", "already_canceled");
  }
  if (booking.startsAt < new Date()) {
    throw new BookingError("Booking already started", "too_late");
  }

  await unscopedPrisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELED", canceledAt: new Date(), cancelReason: reason ?? null },
    });
    if (booking.eventId) {
      await tx.calendarEvent.update({
        where: { id: booking.eventId },
        data: { status: "CANCELED", canceledAt: new Date() },
      });
      await tx.reminder.updateMany({
        where: { eventId: booking.eventId, status: "SCHEDULED" },
        data: { status: "CANCELED" },
      });
    }
    await tx.activity.create({
      data: {
        organizationId: booking.organizationId,
        type: "MEETING",
        subject: `Booking canceled: ${booking.bookingType.name}`,
        body: `${booking.guestName} canceled.${reason ? ` Reason: ${reason}` : ""}`,
        metadata: { bookingId: booking.id, kind: "canceled" },
      },
    });
  });

  await consumeToken(record.id, record.purpose);
  await invalidateBookingTokens(booking.id);

  await audit(
    { orgId: booking.organizationId, userId: booking.bookingType.ownerId },
    {
      action: "booking.cancel",
      resourceType: "booking",
      resourceId: booking.id,
      actorType: "system",
      after: { reason: reason ?? null },
    },
  ).catch(() => undefined);

  await emitWorkflowEvent(booking.organizationId, "booking.canceled", {
    bookingId: booking.id,
    guestEmail: booking.guestEmail,
  }).catch(() => undefined);

  return booking;
}

export async function rescheduleBookingViaToken(raw: string, newStartIso: string) {
  const { resolveToken, consumeToken } = await import("./booking-tokens");
  const record = await resolveToken(raw, "RESCHEDULE");
  const oldBooking = record.booking;

  if (oldBooking.status === "CANCELED") {
    throw new BookingError("Booking was canceled", "already_canceled");
  }

  const bookingType = await unscopedPrisma.bookingType.findFirst({
    where: { id: oldBooking.bookingTypeId, deletedAt: null },
    include: { organization: { select: { slug: true } } },
  });
  if (!bookingType) throw new BookingError("Booking type not found", "not_found");

  const duration = Math.round(
    (oldBooking.endsAt.getTime() - oldBooking.startsAt.getTime()) / 60_000,
  );
  const startsAt = new Date(newStartIso);
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);

  const { slots } = await getPublicSlots({
    orgSlug: bookingType.organization.slug,
    typeSlug: bookingType.slug,
    from: new Date(startsAt.getTime() - 86_400_000),
    to: new Date(endsAt.getTime() + 86_400_000),
    durationMinutes: bookingType.durationOptions.includes(duration)
      ? duration
      : bookingType.durationMinutes,
  });
  if (!slots.some((s) => s.getTime() === startsAt.getTime())) {
    throw new BookingError("Requested time is not available", "invalid_slot");
  }

  const orgId = oldBooking.organizationId;
  const result = await unscopedPrisma.$transaction(async (tx) => {
    await assertSlotStillFree(
      tx,
      orgId,
      bookingType.ownerId,
      startsAt,
      endsAt,
      bookingType.bufferBeforeMinutes,
      bookingType.bufferAfterMinutes,
      oldBooking.eventId ?? undefined,
    );

    if (oldBooking.eventId) {
      await tx.calendarEvent.update({
        where: { id: oldBooking.eventId },
        data: { status: "CANCELED", canceledAt: new Date() },
      });
      await tx.reminder.updateMany({
        where: { eventId: oldBooking.eventId, status: "SCHEDULED" },
        data: { status: "CANCELED" },
      });
    }
    await tx.booking.update({
      where: { id: oldBooking.id },
      data: { status: "RESCHEDULED" },
    });

    const event = await tx.calendarEvent.create({
      data: {
        organizationId: orgId,
        createdById: bookingType.ownerId,
        ownerId: bookingType.ownerId,
        title: `${bookingType.name} — ${oldBooking.guestName}`,
        description: oldBooking.guestNotes,
        location: bookingType.location ?? null,
        timezone: oldBooking.guestTimezone,
        startsAt,
        endsAt,
        source: "BOOKING",
      },
    });
    await tx.eventAttendee.create({
      data: {
        eventId: event.id,
        email: oldBooking.guestEmail,
        name: oldBooking.guestName,
        status: "ACCEPTED",
      },
    });
    const booking = await tx.booking.create({
      data: {
        organizationId: orgId,
        bookingTypeId: bookingType.id,
        eventId: event.id,
        guestName: oldBooking.guestName,
        guestEmail: oldBooking.guestEmail,
        guestPhone: oldBooking.guestPhone,
        guestCompany: oldBooking.guestCompany,
        guestNotes: oldBooking.guestNotes,
        guestTimezone: oldBooking.guestTimezone,
        guestLocale: oldBooking.guestLocale,
        consentAt: oldBooking.consentAt,
        startsAt,
        endsAt,
        rescheduledFromId: oldBooking.id,
      },
    });
    await tx.activity.create({
      data: {
        organizationId: orgId,
        type: "MEETING",
        subject: `Booking rescheduled: ${bookingType.name}`,
        body: `${oldBooking.guestName} moved the meeting.`,
        dueAt: startsAt,
        metadata: { bookingId: booking.id, previousBookingId: oldBooking.id, kind: "rescheduled" },
      },
    });
    return { booking, event };
  });

  await consumeToken(record.id, record.purpose);
  await invalidateBookingTokens(oldBooking.id);
  const manageToken = await issueToken(result.booking.id, "MANAGE");

  await audit(
    { orgId, userId: bookingType.ownerId },
    {
      action: "booking.reschedule",
      resourceType: "booking",
      resourceId: result.booking.id,
      actorType: "system",
      before: { startsAt: oldBooking.startsAt.toISOString() },
      after: { startsAt: startsAt.toISOString() },
    },
  ).catch(() => undefined);

  await emitWorkflowEvent(orgId, "booking.rescheduled", {
    bookingId: result.booking.id,
    guestEmail: oldBooking.guestEmail,
    startsAt: startsAt.toISOString(),
  }).catch(() => undefined);

  return { ...result, manageToken, bookingType };
}
