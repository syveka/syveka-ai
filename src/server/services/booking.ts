import "server-only";

import { Prisma, type Locale } from "@prisma/client";
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
import {
  lockAiDefaultBookingType,
  lockContactEmail,
  lockOrgCalendar,
  lockOwnerCalendar,
} from "@/server/calendar/locks";
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
      | "already_canceled"
      | "ai_booking_type_not_configured"
      | "ai_booking_type_ambiguous",
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

/** A guest booking form only collects one free-text name field; Contact wants firstName/lastName separately. */
function splitGuestName(fullName: string): { firstName: string; lastName: string | null } {
  const trimmed = fullName.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { firstName: trimmed, lastName: null };
  return {
    firstName: trimmed.slice(0, spaceIndex),
    lastName: trimmed.slice(spaceIndex + 1).trim() || null,
  };
}

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
    isAiBookingDefault: input.isAiBookingDefault,
  };

  try {
    // Claiming isAiBookingDefault=true is race-sensitive (at most one per
    // org) and needs real serialization across concurrent claims touching
    // DIFFERENT rows - see lockAiDefaultBookingType's doc comment for why a
    // plain transaction alone is not sufficient. Only this branch pays for
    // the lock + unscoped-with-manual-scoping write: a claim of `false` (or
    // omitted) can never create a second true row on its own, so it keeps
    // the original tenantDb path unchanged.
    const result = input.isAiBookingDefault
      ? await unscopedPrisma.$transaction(async (tx) => {
          await lockAiDefaultBookingType(tx, ctx.orgId);

          const row = bookingTypeId
            ? await tx.bookingType.update({
                where: { id: bookingTypeId, organizationId: ctx.orgId },
                data: { ...data, organizationId: ctx.orgId },
              })
            : await tx.bookingType.create({
                data: { ...data, organizationId: ctx.orgId, ownerId: ctx.userId },
              });

          // Still inside the lock: no concurrent claim in this org can
          // observe or race this cleanup - see lockAiDefaultBookingType.
          await tx.bookingType.updateMany({
            where: { organizationId: ctx.orgId, id: { not: row.id }, isAiBookingDefault: true },
            data: { isAiBookingDefault: false },
          });
          return row;
        })
      : bookingTypeId
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
 * Guest-facing booking creation. Double-booking protection: the requested slot is
 * validated against computed availability, then re-checked inside the write
 * transaction under lockOwnerCalendar()'s advisory lock - the lock, not
 * the transaction alone, is what prevents two concurrent guests from both
 * committing (see that function's comment for why a bare re-check isn't enough
 * under Postgres's default READ COMMITTED isolation).
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
    await lockOwnerCalendar(tx, orgId, bookingType.ownerId);
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

    // Find-then-create, not upsert: Contact has no unique constraint on
    // (organizationId, email) - only an index (schema.prisma) - a real
    // customer can legitimately share an email with another contact record.
    // Serialized via lockContactEmail (a dedicated advisory lock, distinct
    // from lockOwnerCalendar above) so two concurrent bookings for the SAME
    // new guest email - including across two DIFFERENT booking types/owners,
    // which lockOwnerCalendar's per-owner key does not itself serialize -
    // cannot both pass the find-then-create race. Found and closed during
    // PR #91 review with a deterministic real-Postgres reproduction; the
    // AI tool's own createContact has a similar-shaped gap, tracked
    // separately since it has no equivalent transaction to hook into here.
    await lockContactEmail(tx, orgId, input.email);
    let matchedContact = await tx.contact.findFirst({
      where: { organizationId: orgId, email: input.email, deletedAt: null },
      select: { id: true },
    });
    if (!matchedContact) {
      const { firstName, lastName } = splitGuestName(input.name);
      matchedContact = await tx.contact.create({
        data: {
          organizationId: orgId,
          firstName,
          lastName,
          email: input.email,
          phone: input.phone ?? null,
          source: "public-booking",
          gdprConsentAt: input.consent ? new Date() : null,
        },
        select: { id: true },
      });
    }

    await tx.eventAttendee.create({
      data: {
        eventId: event.id,
        contactId: matchedContact.id,
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
        contactId: matchedContact.id,
        type: "MEETING",
        subject: `Booking: ${bookingType.name}`,
        body: `${input.name} (${input.email}) booked ${bookingType.name}.`,
        dueAt: startsAt,
        metadata: { bookingId: booking.id, kind: "booked" },
      },
    });

    return { booking, event, contactId: matchedContact.id };
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

  await emitWorkflowEvent(
    orgId,
    "booking.created",
    {
      bookingId: created.booking.id,
      bookingType: bookingType.name,
      guestName: input.name,
      guestEmail: input.email,
      startsAt: startsAt.toISOString(),
    },
    created.booking.id,
  ).catch(() => undefined);

  return { ...created, manageToken, bookingType };
}

// ── Voice/AI booking path (bookMeeting tool) ─────────────────────────────

export type VoiceBookingInput = {
  orgId: string;
  actorUserId: string;
  title: string;
  startsAt: string; // ISO
  durationMinutes: number;
  timezone: string;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  notes?: string;
  contactId?: string;
  guestLocale?: Locale;
};

/**
 * Resolves the org's single explicit AI-default BookingType. NEVER inferred
 * from an AI-spoken service name (see BookingType.isAiBookingDefault's doc
 * comment in prisma/schema.prisma) — fails loudly and clearly when unset,
 * per the approved architectural constraint for this feature, rather than
 * guessing which BookingType the voice assistant should book into.
 */
async function resolveAiDefaultBookingType(orgId: string) {
  // Fetches up to 2 - enough to detect "more than one" without pulling a
  // potentially large list - and orders deterministically so that IF this
  // function is ever reached in a legacy-corrupted state (an org somehow
  // has more than one row with isAiBookingDefault=true - saveBookingType's
  // lockAiDefaultBookingType now prevents this going forward, but stale
  // data or a pre-fix write could still exist), it fails loudly with a
  // specific, actionable error rather than silently picking an arbitrary
  // row that could differ between calls (findFirst with no orderBy has no
  // stable row order in Postgres).
  const candidates = await unscopedPrisma.bookingType.findMany({
    where: { organizationId: orgId, isAiBookingDefault: true, isActive: true, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
  });
  if (candidates.length === 0) {
    throw new BookingError(
      "No AI-default booking type is configured for this organization. An owner must mark one " +
        'Booking Type as "Use for AI/voice bookings" in Calendar → Booking Types before the ' +
        "voice assistant can book appointments.",
      "ai_booking_type_not_configured",
    );
  }
  if (candidates.length > 1) {
    throw new BookingError(
      "More than one AI-default booking type is configured for this organization, which should " +
        "never happen. An owner must fix this in Calendar → Booking Types (only one should have " +
        '"Use for AI/voice bookings" enabled) before the voice assistant can book appointments.',
      "ai_booking_type_ambiguous",
    );
  }
  return candidates[0]!;
}

/**
 * Voice/AI booking creation (bookMeeting tool, src/server/ai/tools/index.ts).
 * Produces the SAME `Booking` + `CalendarEvent` + `Contact`/`EventAttendee`
 * shape as `createPublicBooking` above, so voice bookings flow through the
 * exact same confirmation-email, reminder, and cancellation code as guest
 * web bookings — one source of truth, not a parallel system.
 *
 * Deliberately reuses `lockOrgCalendar()` + an org-wide (not
 * `bookingType.ownerId`-scoped) conflict check, matching bookMeeting's
 * existing, unchanged concurrency model and `getCalendarAvailability`'s
 * existing (also org-wide, bufferless) slot computation — see
 * docs/DECISIONS.md's "AI tools intentionally treat the company calendar as
 * one shared bookable resource" entry. Unifying that with the guest flow's
 * per-owner, buffered model is out of scope for this change (see the P2
 * completion report's "Unresolved issues" section); only the *default
 * BookingType's identity* (name/location for notifications, ownerId for the
 * Google push target) is borrowed here, not its schedule/buffer/window
 * fields.
 */
export async function createVoiceBooking(input: VoiceBookingInput) {
  const bookingType = await resolveAiDefaultBookingType(input.orgId);
  const orgId = input.orgId;
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);

  const created = await unscopedPrisma.$transaction(async (tx) => {
    await lockOrgCalendar(tx, orgId);

    const conflict = await tx.calendarEvent.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: { not: "CANCELED" },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { id: true },
    });
    if (conflict) throw new BookingError("Slot no longer available", "slot_taken");

    let contactId = input.contactId ?? null;
    if (contactId) {
      // Tenancy check: a model-supplied contactId is untrusted input and
      // CalendarEvent.contactId has no DB-level FK (see docs/DECISIONS.md).
      await tx.contact.findFirstOrThrow({ where: { id: contactId, organizationId: orgId } });
    } else {
      // Find-then-create, lock-guarded exactly like createPublicBooking's
      // identical block above — same race, same fix.
      await lockContactEmail(tx, orgId, input.guestEmail);
      const matched = await tx.contact.findFirst({
        where: { organizationId: orgId, email: input.guestEmail, deletedAt: null },
        select: { id: true },
      });
      if (matched) {
        contactId = matched.id;
      } else {
        const { firstName, lastName } = splitGuestName(input.guestName);
        const createdContact = await tx.contact.create({
          data: {
            organizationId: orgId,
            firstName,
            lastName,
            email: input.guestEmail,
            phone: input.guestPhone ?? null,
            source: "voice-ai",
          },
          select: { id: true },
        });
        contactId = createdContact.id;
      }
    }

    const event = await tx.calendarEvent.create({
      data: {
        organizationId: orgId,
        createdById: input.actorUserId,
        title: input.title,
        description: input.notes ?? null,
        location: bookingType.location ?? null,
        timezone: input.timezone,
        startsAt,
        endsAt,
        contactId,
        source: "VOICE_AI",
      },
    });

    await tx.eventAttendee.create({
      data: {
        eventId: event.id,
        contactId,
        email: input.guestEmail,
        name: input.guestName,
        status: "ACCEPTED",
      },
    });

    const booking = await tx.booking.create({
      data: {
        organizationId: orgId,
        bookingTypeId: bookingType.id,
        eventId: event.id,
        guestName: input.guestName,
        guestEmail: input.guestEmail,
        guestPhone: input.guestPhone ?? null,
        guestNotes: input.notes ?? null,
        guestTimezone: input.timezone,
        guestLocale: input.guestLocale ?? null,
        startsAt,
        endsAt,
      },
    });

    await tx.activity.create({
      data: {
        organizationId: orgId,
        contactId,
        type: "MEETING",
        subject: `Booking: ${bookingType.name}`,
        body: `${input.guestName} (${input.guestEmail}) booked ${bookingType.name} via the AI voice assistant.`,
        dueAt: startsAt,
        metadata: { bookingId: booking.id, kind: "booked", via: "voice_ai" },
      },
    });

    return { booking, event, contactId };
  });

  const manageToken = await issueToken(created.booking.id, "MANAGE");

  await audit(
    { orgId, userId: input.actorUserId },
    {
      action: "booking.create",
      resourceType: "booking",
      resourceId: created.booking.id,
      actorType: "voice_ai",
      after: { guestEmail: input.guestEmail, startsAt: startsAt.toISOString() },
    },
  ).catch(() => undefined);

  await emitWorkflowEvent(
    orgId,
    "booking.created",
    {
      bookingId: created.booking.id,
      bookingType: bookingType.name,
      guestName: input.guestName,
      guestEmail: input.guestEmail,
      startsAt: startsAt.toISOString(),
    },
    created.booking.id,
  ).catch(() => undefined);

  return { ...created, manageToken, bookingType };
}

// ── Cancel / reschedule via secure tokens ────────────────────────────────

export async function getBookingByToken(raw: string) {
  const { resolveToken } = await import("./booking-tokens");
  const record = await resolveToken(raw, "MANAGE");
  return record.booking;
}

/**
 * Shared atomic core for both cancel paths (guest token and authenticated
 * owner): re-reads booking status inside the transaction (closing the replay
 * window a pre-transaction-only check would leave open), then cancels the
 * booking, its calendar event, and any still-scheduled reminders together so
 * neither path can produce a state where one of these updates but not the
 * others.
 */
async function cancelBookingCore(
  tx: Prisma.TransactionClient,
  bookingId: string,
  reason: string | undefined,
) {
  const fresh = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { bookingType: true },
  });
  if (fresh.status === "CANCELED" || fresh.status === "RESCHEDULED") {
    // A RESCHEDULED booking has already been superseded by a successor
    // booking (rescheduledFromId) - it is no longer the guest's active
    // appointment, so "canceling" it here would flip a historical record's
    // status and could send the guest a misleading cancellation email for
    // an appointment that is actually still live at its new time.
    throw new BookingError("Already canceled", "already_canceled");
  }
  if (fresh.startsAt < new Date()) {
    throw new BookingError("Booking already started", "too_late");
  }

  // Guarded, not a blind update: closes the race between two callers that
  // both pass the status check above before either commits (e.g. an
  // owner-cancel racing a guest-token-cancel or a guest-token-reschedule, or
  // two concurrent owner-cancels - neither has any other serialization to
  // fall back on once inside this shared core; cancelBookingViaToken's
  // token-consumption guard runs BEFORE this and doesn't protect what
  // happens in here, and rescheduleBookingViaToken's own booking-update is
  // guarded the same way below for the same reason). Whichever
  // transaction's UPDATE lands first wins the row lock; the second one, on
  // unblocking, re-evaluates this WHERE clause against the now-committed
  // row, matches zero rows, and must reject here instead of silently
  // re-running every side effect below a second time.
  const claimed = await tx.booking.updateMany({
    where: { id: bookingId, status: { notIn: ["CANCELED", "RESCHEDULED"] } },
    data: { status: "CANCELED", canceledAt: new Date(), cancelReason: reason ?? null },
  });
  if (claimed.count === 0) {
    throw new BookingError("Already canceled", "already_canceled");
  }
  if (fresh.eventId) {
    await tx.calendarEvent.update({
      where: { id: fresh.eventId },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await tx.reminder.updateMany({
      where: { eventId: fresh.eventId, status: "SCHEDULED" },
      data: { status: "CANCELED" },
    });
  }
  await tx.activity.create({
    data: {
      organizationId: fresh.organizationId,
      type: "MEETING",
      subject: `Booking canceled: ${fresh.bookingType.name}`,
      body: `${fresh.guestName} canceled.${reason ? ` Reason: ${reason}` : ""}`,
      metadata: { bookingId: fresh.id, kind: "canceled" },
    },
  });
  return fresh;
}

export async function cancelBookingViaToken(raw: string, reason?: string) {
  const { resolveToken, consumeTokenAtomic } = await import("./booking-tokens");
  const record = await resolveToken(raw, "CANCEL");
  const bookingId = record.booking.id;

  const booking = await unscopedPrisma.$transaction(async (tx) => {
    // Atomically claims this token AND re-reads booking status inside the
    // same transaction as the mutation below - closes the replay window a
    // pre-transaction-only check would leave open (see consumeTokenAtomic's
    // doc comment).
    await consumeTokenAtomic(tx, record.id);
    return cancelBookingCore(tx, bookingId, reason);
  });

  // Belt-and-braces: also invalidate any OTHER outstanding tokens for this
  // booking (e.g. if more than one was ever issued) - the token actually
  // used above is already consumed atomically by consumeTokenAtomic.
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

  await emitWorkflowEvent(
    booking.organizationId,
    "booking.canceled",
    { bookingId: booking.id, guestEmail: booking.guestEmail },
    booking.id,
  ).catch(() => undefined);

  return booking;
}

/**
 * Owner-authenticated equivalent of cancelBookingViaToken, for a booking
 * canceled from the owner's own calendar UI (calendar.ts's cancelEvent)
 * rather than the guest's token link. Found missing during Pilot-readiness
 * review: cancelEvent() only flipped CalendarEvent.status, leaving
 * Booking.status stale (CONFIRMED), reminders still SCHEDULED (the guest
 * would still get a reminder for an appointment the owner believes is
 * canceled), and the guest never notified. Reuses cancelBookingCore so both
 * paths leave the exact same state and notify the guest identically -
 * tenant ownership is verified via tenantDb before the transaction runs,
 * exactly as every other owner-authenticated booking read already does
 * (see listBookings above).
 */
export async function cancelBookingAsOwner(ctx: TenantContext, bookingId: string, reason?: string) {
  const existing = await tenantDb(ctx.orgId).booking.findFirst({
    where: { id: bookingId },
    select: { id: true },
  });
  if (!existing) throw new BookingError("Booking not found", "not_found");

  const booking = await unscopedPrisma.$transaction((tx) =>
    cancelBookingCore(tx, bookingId, reason),
  );

  await invalidateBookingTokens(booking.id);

  await audit(ctx, {
    action: "booking.cancel",
    resourceType: "booking",
    resourceId: booking.id,
    after: { reason: reason ?? null },
  }).catch(() => undefined);

  await emitWorkflowEvent(
    booking.organizationId,
    "booking.canceled",
    { bookingId: booking.id, guestEmail: booking.guestEmail },
    booking.id,
  ).catch(() => undefined);

  // Same notification the guest's own manage-link cancel sends (see
  // src/app/api/v1/booking/manage/[token]/route.ts) - found missing during
  // Pilot-readiness review. Redis-idempotency-guarded inside
  // sendBookingLifecycleNotifications itself, so this is safe even if
  // called more than once for the same booking/kind.
  const { sendBookingLifecycleNotifications } = await import("./booking-notifications");
  await sendBookingLifecycleNotifications({ kind: "cancellation", bookingId: booking.id }).catch(
    () => undefined,
  );

  // Best-effort Google push-cancel (P2: unified booking lifecycle). Never
  // throws (see cancelBookingEventOnGoogle's contract) and never blocks the
  // cancellation, which has already committed above.
  if (booking.eventId) {
    const { cancelBookingEventOnGoogle } = await import("./calendar-sync");
    await cancelBookingEventOnGoogle({ eventId: booking.eventId }).catch(() => undefined);
  }

  return booking;
}

export async function rescheduleBookingViaToken(raw: string, newStartIso: string) {
  const { resolveToken, consumeTokenAtomic } = await import("./booking-tokens");
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
    // Atomically claims this token AND re-reads booking status inside the
    // same transaction as the mutation below - see consumeTokenAtomic's doc
    // comment and cancelBookingViaToken's identical treatment above.
    await consumeTokenAtomic(tx, record.id);
    const freshOld = await tx.booking.findUniqueOrThrow({ where: { id: oldBooking.id } });
    if (freshOld.status === "CANCELED") {
      throw new BookingError("Booking was canceled", "already_canceled");
    }

    await lockOwnerCalendar(tx, orgId, bookingType.ownerId);
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

    // Guarded, not a blind update: closes the race against a concurrent
    // owner-cancel (calendar.ts's cancelEvent -> booking.ts's
    // cancelBookingAsOwner), which shares no lock or token with this path
    // and can cancel this same booking between the freshOld read above and
    // this update. Whichever side's UPDATE lands first wins the row lock;
    // the loser's UPDATE re-evaluates this WHERE clause against the
    // now-committed row, matches zero rows, and must reject here - BEFORE
    // canceling the old calendar event or creating a successor - instead of
    // resurrecting a booking the other caller just canceled.
    const claimed = await tx.booking.updateMany({
      where: { id: oldBooking.id, status: { notIn: ["CANCELED", "RESCHEDULED"] } },
      data: { status: "RESCHEDULED" },
    });
    if (claimed.count === 0) {
      throw new BookingError("Booking was canceled", "already_canceled");
    }

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

  // Belt-and-braces: also invalidate any OTHER outstanding tokens for the
  // old booking - the token actually used above is already consumed
  // atomically by consumeTokenAtomic, inside the same transaction.
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

  await emitWorkflowEvent(
    orgId,
    "booking.rescheduled",
    {
      bookingId: result.booking.id,
      guestEmail: oldBooking.guestEmail,
      startsAt: startsAt.toISOString(),
    },
    // The successor booking's own id - fresh per reschedule occurrence, so
    // this is naturally distinct from both the original booking and any
    // later reschedule of the same booking (each creates its own successor).
    result.booking.id,
  ).catch(() => undefined);

  return { ...result, manageToken, bookingType };
}
