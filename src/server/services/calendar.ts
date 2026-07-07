import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { EventInput } from "@/lib/validators/calendar";

export async function listEvents(ctx: TenantContext, range: { from: Date; to: Date }) {
  const db = tenantDb(ctx.orgId);
  return db.calendarEvent.findMany({
    where: { startsAt: { lt: range.to }, endsAt: { gt: range.from } },
    orderBy: { startsAt: "asc" },
    take: 500,
  });
}

export async function createEvent(ctx: TenantContext, input: EventInput) {
  const db = tenantDb(ctx.orgId);
  const event = await db.calendarEvent.create({
    data: {
      title: input.title,
      description: input.description || null,
      location: input.location || null,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      allDay: input.allDay,
      contactId: input.contactId,
      createdById: ctx.userId,
      source: "MANUAL",
    },
  });
  await audit(ctx, {
    action: "calendar.create",
    resourceType: "calendar_event",
    resourceId: event.id,
    after: { title: input.title, startsAt: input.startsAt },
  });
  return event;
}

export async function updateEvent(ctx: TenantContext, eventId: string, input: EventInput) {
  const db = tenantDb(ctx.orgId);
  const event = await db.calendarEvent.update({
    where: { id: eventId },
    data: {
      title: input.title,
      description: input.description || null,
      location: input.location || null,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      allDay: input.allDay,
    },
  });
  await audit(ctx, {
    action: "calendar.update",
    resourceType: "calendar_event",
    resourceId: eventId,
  });
  return event;
}

export async function deleteEvent(ctx: TenantContext, eventId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const event = await db.calendarEvent.findFirstOrThrow({ where: { id: eventId } });
  await db.calendarEvent.delete({ where: { id: eventId } });
  await audit(ctx, {
    action: "calendar.delete",
    resourceType: "calendar_event",
    resourceId: eventId,
    before: { title: event.title },
  });
}
