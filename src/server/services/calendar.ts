import "server-only";

import { tenantDb, unscopedPrisma, type TenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import {
  validateRecurrenceRule,
  expandOccurrences,
  RecurrenceError,
} from "@/server/calendar/recurrence";
import { isValidTimezone } from "@/server/calendar/timezone";
import { intervalsOverlap } from "@/server/calendar/slots";
import type { TenantContext } from "@/server/auth/session";
import type { EventFilters, EventInput } from "@/lib/validators/calendar";
import type { Prisma } from "@prisma/client";

export class CalendarError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "invalid_timezone"
      | "invalid_recurrence"
      | "invalid_owner"
      | "invalid_relation"
      | "conflict",
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

const EVENT_INCLUDE = {
  attendeeRecords: {
    include: { contact: { select: { id: true, firstName: true, lastName: true, email: true } } },
  },
  booking: { select: { id: true, status: true, guestName: true, guestEmail: true } },
} satisfies Prisma.CalendarEventInclude;

/**
 * Cross-tenant relationship rejection: every linked entity must resolve
 * inside the caller's organization (tenantDb injects the org filter, so a
 * foreign id simply doesn't resolve).
 */
async function assertRelations(
  db: TenantDb,
  orgId: string,
  input: Pick<EventInput, "contactId" | "companyId" | "dealId" | "ownerId">,
): Promise<void> {
  const checks: Promise<unknown>[] = [];
  if (input.contactId) {
    checks.push(
      db.contact
        .findFirst({ where: { id: input.contactId, deletedAt: null }, select: { id: true } })
        .then((r) => {
          if (!r) throw new CalendarError("Contact not in organization", "invalid_relation");
        }),
    );
  }
  if (input.companyId) {
    checks.push(
      db.company
        .findFirst({ where: { id: input.companyId, deletedAt: null }, select: { id: true } })
        .then((r) => {
          if (!r) throw new CalendarError("Company not in organization", "invalid_relation");
        }),
    );
  }
  if (input.dealId) {
    checks.push(
      db.deal
        .findFirst({ where: { id: input.dealId, deletedAt: null }, select: { id: true } })
        .then((r) => {
          if (!r) throw new CalendarError("Deal not in organization", "invalid_relation");
        }),
    );
  }
  if (input.ownerId) {
    checks.push(
      db.organizationMember
        .findFirst({ where: { userId: input.ownerId }, select: { id: true } })
        .then((r) => {
          if (!r) throw new CalendarError("Owner is not a member", "invalid_owner");
        }),
    );
  }
  await Promise.all(checks);
}

function validateEventInput(input: EventInput): void {
  if (!isValidTimezone(input.timezone)) {
    throw new CalendarError(`Unknown timezone: ${input.timezone}`, "invalid_timezone");
  }
  if (input.recurrenceRule) {
    try {
      validateRecurrenceRule(input.recurrenceRule);
    } catch (e) {
      if (e instanceof RecurrenceError) {
        throw new CalendarError(e.message, "invalid_recurrence");
      }
      throw e;
    }
  }
}

/**
 * Detect overlapping events for the same owner (or creator when no owner).
 * Returns conflicting event ids; callers decide whether to block or warn.
 */
export async function findConflicts(
  ctx: TenantContext,
  params: {
    startsAt: Date;
    endsAt: Date;
    ownerId?: string | null;
    excludeEventId?: string;
  },
): Promise<Array<{ id: string; title: string; startsAt: Date; endsAt: Date }>> {
  const db = tenantDb(ctx.orgId);
  const owner = params.ownerId ?? ctx.userId;
  const candidates = await db.calendarEvent.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELED" },
      OR: [{ ownerId: owner }, { ownerId: null, createdById: owner }],
      ...(params.excludeEventId ? { id: { not: params.excludeEventId } } : {}),
      // Non-recurring overlap in SQL; recurring series pre-filtered by start.
      startsAt: { lt: new Date(params.endsAt.getTime() + 90 * 86_400_000) },
    },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      recurrenceRule: true,
    },
    take: 500,
  });

  const conflicts: Array<{ id: string; title: string; startsAt: Date; endsAt: Date }> = [];
  for (const e of candidates) {
    if (!e.recurrenceRule) {
      if (intervalsOverlap(params.startsAt, params.endsAt, e.startsAt, e.endsAt)) {
        conflicts.push({ id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt });
      }
      continue;
    }
    try {
      const rule = validateRecurrenceRule(e.recurrenceRule);
      const occurrences = expandOccurrences({
        seriesStart: e.startsAt,
        seriesEnd: e.endsAt,
        rule,
        rangeFrom: params.startsAt,
        rangeTo: params.endsAt,
        max: 5,
      });
      const hit = occurrences.find((o) =>
        intervalsOverlap(params.startsAt, params.endsAt, o.startsAt, o.endsAt),
      );
      if (hit)
        conflicts.push({ id: e.id, title: e.title, startsAt: hit.startsAt, endsAt: hit.endsAt });
    } catch {
      // Unparseable legacy rule: treat series anchor only.
      if (intervalsOverlap(params.startsAt, params.endsAt, e.startsAt, e.endsAt)) {
        conflicts.push({ id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt });
      }
    }
  }
  return conflicts;
}

/** List events intersecting [from, to), expanding recurring series. */
export async function listEvents(
  ctx: TenantContext,
  range: { from: Date; to: Date },
  filters?: Partial<EventFilters>,
) {
  const db = tenantDb(ctx.orgId);
  const where: Prisma.CalendarEventWhereInput = {
    deletedAt: null,
    ...(filters?.q
      ? {
          OR: [
            { title: { contains: filters.q, mode: "insensitive" } },
            { description: { contains: filters.q, mode: "insensitive" } },
            { location: { contains: filters.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(filters?.ownerId ? { ownerId: filters.ownerId } : {}),
    ...(filters?.contactId ? { contactId: filters.contactId } : {}),
    ...(filters?.companyId ? { companyId: filters.companyId } : {}),
    ...(filters?.dealId ? { dealId: filters.dealId } : {}),
    ...(filters?.source ? { source: filters.source } : {}),
  };

  const [plain, recurring] = await Promise.all([
    db.calendarEvent.findMany({
      where: {
        ...where,
        recurrenceRule: null,
        startsAt: { lt: range.to },
        endsAt: { gt: range.from },
      },
      include: EVENT_INCLUDE,
      orderBy: { startsAt: "asc" },
      take: 500,
    }),
    db.calendarEvent.findMany({
      where: { ...where, recurrenceRule: { not: null }, startsAt: { lt: range.to } },
      include: EVENT_INCLUDE,
      orderBy: { startsAt: "asc" },
      take: 200,
    }),
  ]);

  const expanded = recurring.flatMap((e) => {
    try {
      const rule = validateRecurrenceRule(e.recurrenceRule!);
      return expandOccurrences({
        seriesStart: e.startsAt,
        seriesEnd: e.endsAt,
        rule,
        rangeFrom: range.from,
        rangeTo: range.to,
        max: 100,
      }).map((occ) => ({ ...e, startsAt: occ.startsAt, endsAt: occ.endsAt, isOccurrence: true }));
    } catch {
      return intervalsOverlap(range.from, range.to, e.startsAt, e.endsAt)
        ? [{ ...e, isOccurrence: false }]
        : [];
    }
  });

  return [...plain.map((e) => ({ ...e, isOccurrence: false })), ...expanded].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

export async function getEvent(ctx: TenantContext, eventId: string) {
  const db = tenantDb(ctx.orgId);
  return db.calendarEvent.findFirst({
    where: { id: eventId, deletedAt: null },
    include: EVENT_INCLUDE,
  });
}

async function syncAttendees(
  db: TenantDb,
  orgId: string,
  eventId: string,
  attendees: EventInput["attendees"],
): Promise<void> {
  // Verify contact links stay inside the tenant before writing child rows.
  const contactIds = attendees.map((a) => a.contactId).filter((v): v is string => Boolean(v));
  if (contactIds.length > 0) {
    const found = await db.contact.count({ where: { id: { in: contactIds }, deletedAt: null } });
    if (found !== new Set(contactIds).size) {
      throw new CalendarError("Attendee contact not in organization", "invalid_relation");
    }
  }
  // EventAttendee is parent-scoped: operate through the verified event id.
  await unscopedPrisma.eventAttendee.deleteMany({ where: { eventId } });
  if (attendees.length > 0) {
    await unscopedPrisma.eventAttendee.createMany({
      data: attendees.map((a) => ({
        eventId,
        contactId: a.contactId ?? null,
        userId: a.userId ?? null,
        email: a.email ?? null,
        name: a.name ?? null,
      })),
    });
  }
}

export async function createEvent(ctx: TenantContext, input: EventInput) {
  validateEventInput(input);
  const db = tenantDb(ctx.orgId);
  await assertRelations(db, ctx.orgId, input);

  const event = await db.calendarEvent.create({
    data: {
      organizationId: ctx.orgId,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      timezone: input.timezone,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      allDay: input.allDay,
      recurrenceRule: input.recurrenceRule ?? null,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      ownerId: input.ownerId ?? ctx.userId,
      createdById: ctx.userId,
      source: "MANUAL",
    },
  });
  await syncAttendees(db, ctx.orgId, event.id, input.attendees);

  await audit(ctx, {
    action: "calendar.create",
    resourceType: "calendar_event",
    resourceId: event.id,
    after: { title: input.title, startsAt: input.startsAt },
  });
  return event;
}

export async function updateEvent(ctx: TenantContext, eventId: string, input: EventInput) {
  validateEventInput(input);
  const db = tenantDb(ctx.orgId);
  const existing = await db.calendarEvent.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!existing) throw new CalendarError("Event not found", "not_found");
  await assertRelations(db, ctx.orgId, input);

  const event = await db.calendarEvent.update({
    where: { id: eventId },
    data: {
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      timezone: input.timezone,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      allDay: input.allDay,
      recurrenceRule: input.recurrenceRule ?? null,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      ownerId: input.ownerId ?? undefined,
    },
  });
  await syncAttendees(db, ctx.orgId, eventId, input.attendees);

  await audit(ctx, {
    action: "calendar.update",
    resourceType: "calendar_event",
    resourceId: eventId,
    before: { title: existing.title },
    after: { title: input.title },
  });
  return event;
}

/** Soft-cancel: keeps the row (and its booking/audit trail) but frees the slot. */
export async function cancelEvent(ctx: TenantContext, eventId: string) {
  const db = tenantDb(ctx.orgId);
  const existing = await db.calendarEvent.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!existing) throw new CalendarError("Event not found", "not_found");

  const event = await db.calendarEvent.update({
    where: { id: eventId },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
  await audit(ctx, {
    action: "calendar.cancel",
    resourceType: "calendar_event",
    resourceId: eventId,
    before: { title: existing.title },
  });
  return event;
}

export async function deleteEvent(ctx: TenantContext, eventId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const event = await db.calendarEvent.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!event) throw new CalendarError("Event not found", "not_found");

  await db.calendarEvent.update({
    where: { id: eventId },
    data: { deletedAt: new Date() },
  });
  await audit(ctx, {
    action: "calendar.delete",
    resourceType: "calendar_event",
    resourceId: eventId,
    before: { title: event.title },
  });
}

/** Upcoming meetings for the dashboard widget. */
export async function getUpcomingMeetings(ctx: TenantContext, limit = 5) {
  const db = tenantDb(ctx.orgId);
  return db.calendarEvent.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELED" },
      startsAt: { gte: new Date() },
    },
    orderBy: { startsAt: "asc" },
    take: limit,
    include: {
      attendeeRecords: { select: { id: true, name: true, email: true } },
      booking: { select: { id: true, guestName: true } },
    },
  });
}

/** Event timeline for a CRM entity page (contact, company or deal). */
export async function getEntityEvents(
  ctx: TenantContext,
  entity: { contactId?: string; companyId?: string; dealId?: string },
  limit = 20,
) {
  const db = tenantDb(ctx.orgId);
  const now = new Date();
  const where: Prisma.CalendarEventWhereInput = {
    deletedAt: null,
    ...(entity.contactId ? { contactId: entity.contactId } : {}),
    ...(entity.companyId ? { companyId: entity.companyId } : {}),
    ...(entity.dealId ? { dealId: entity.dealId } : {}),
  };
  const [upcoming, past] = await Promise.all([
    db.calendarEvent.findMany({
      where: { ...where, startsAt: { gte: now }, status: { not: "CANCELED" } },
      orderBy: { startsAt: "asc" },
      take: limit,
    }),
    db.calendarEvent.findMany({
      where: { ...where, startsAt: { lt: now } },
      orderBy: { startsAt: "desc" },
      take: limit,
    }),
  ]);
  return { upcoming, past };
}

/** Owner options (org members) for assignment dropdowns. */
export async function listCalendarOwnerOptions(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const members = await db.organizationMember.findMany({
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { joinedAt: "asc" },
    take: 500,
  });
  return members.map((m) => ({
    id: m.user.id,
    name: m.user.fullName ?? m.user.email,
  }));
}
