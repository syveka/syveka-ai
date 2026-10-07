import React from "react";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../../messages/en.json";
import type { getEntityEvents as GetEntityEvents } from "@/server/services/calendar";
import type { EntityMeetings as EntityMeetingsComponent } from "@/components/calendar/entity-meetings";

/**
 * CRM Meetings on real Postgres with the real tenantDb scoping: a contact's
 * meetings are found through CalendarEvent.contactId OR an EventAttendee row
 * (how public bookings link the guest), each event once, never across
 * organizations, without deleted ones, and canceled ones only in the past.
 * Then the real EntityMeetings renders the staging case -- a booking at
 * 06:00Z linked only through its attendee -- as 9:00 for a Helsinki viewer.
 *
 * Skipped unless ENTITY_EVENTS_PG_URL points at a scratch database prepared
 * as in CI (tests/migrations/supabase-compatibility.sql, then
 * `prisma migrate deploy`). Not run in CI.
 */

const PG_URL = process.env.ENTITY_EVENTS_PG_URL;
vi.hoisted(() => {
  if (process.env.ENTITY_EVENTS_PG_URL) process.env.DATABASE_URL = process.env.ENTITY_EVENTS_PG_URL;
});

vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages, namespace: namespace as "calendar" }),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe.skipIf(!PG_URL)("CRM Meetings on real Postgres", () => {
  type Model = { create: (a: object) => Promise<{ id: string }> };
  type Db = {
    organization: Model;
    user: Model;
    contact: Model;
    calendarEvent: Model;
    eventAttendee: Model;
    $disconnect: () => Promise<void>;
  };
  let db: Db;
  let getEntityEvents: typeof GetEntityEvents;
  let EntityMeetings: typeof EntityMeetingsComponent;
  const ids: Record<string, string> = {};
  const DAY = 86_400_000;

  beforeAll(async () => {
    const tenant = await import("@/server/db/tenant");
    db = tenant.unscopedPrisma as unknown as Db;
    ({ getEntityEvents } = await import("@/server/services/calendar"));
    ({ EntityMeetings } = await import("@/components/calendar/entity-meetings"));

    const org = await db.organization.create({
      data: { name: "Meetings test", slug: `meet-${randomUUID()}` },
    });
    const other = await db.organization.create({
      data: { name: "Other org", slug: `meet-${randomUUID()}` },
    });
    const viewer = await db.user.create({
      data: {
        id: randomUUID(),
        email: `viewer-${randomUUID()}@example.test`,
        timezone: "Europe/Helsinki",
      },
    });
    const contact = await db.contact.create({
      data: { organizationId: org.id, firstName: "Guest" },
    });
    Object.assign(ids, { org: org.id, other: other.id, viewer: viewer.id, contact: contact.id });

    const event = async (orgId: string, title: string, startsAt: Date, extra: object = {}) =>
      (
        await db.calendarEvent.create({
          data: {
            organizationId: orgId,
            createdById: viewer.id,
            title,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 30 * 60_000),
            timezone: "Europe/Helsinki",
            ...extra,
          },
        })
      ).id;
    const attend = (eventId: string, contactId: string) =>
      db.eventAttendee.create({ data: { eventId, contactId, email: "guest@example.test" } });

    // 09:00 Helsinki (EEST) in the future, as booked on staging.
    const nine = new Date(Date.UTC(2099, 9, 8, 6, 0));
    ids.booking = await event(org.id, "Public booking", nine, { source: "BOOKING" });
    await attend(ids.booking, contact.id);
    ids.direct = await event(org.id, "Direct link", new Date(Date.now() + 2 * DAY), {
      contactId: contact.id,
    });
    ids.both = await event(org.id, "Both links", new Date(Date.now() + 3 * DAY), {
      contactId: contact.id,
    });
    await attend(ids.both, contact.id);
    await attend(ids.both, contact.id); // two attendee rows for the same contact
    ids.canceledUpcoming = await event(org.id, "Canceled", new Date(Date.now() + 4 * DAY), {
      status: "CANCELED",
    });
    await attend(ids.canceledUpcoming, contact.id);
    ids.past = await event(org.id, "Past", new Date(Date.now() - 2 * DAY));
    await attend(ids.past, contact.id);
    ids.deleted = await event(org.id, "Deleted", new Date(Date.now() + 5 * DAY), {
      deletedAt: new Date(),
    });
    await attend(ids.deleted, contact.id);
    // Another organization's event pointing at this contact must never show.
    ids.foreign = await event(other.id, "Foreign", new Date(Date.now() + 6 * DAY));
    await attend(ids.foreign, contact.id);
    ids.unrelated = await event(org.id, "Unrelated", new Date(Date.now() + 7 * DAY));
    // First Prisma connection plus seeding; generous under full-suite load.
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  const ctx = () => ({ orgId: ids.org!, userId: ids.viewer!, role: "OWNER" }) as never;

  it("finds attendee-linked and direct meetings, each once, only in the caller's org", async () => {
    const { upcoming, past } = await getEntityEvents(ctx(), { contactId: ids.contact });
    const up = upcoming.map((e) => e.id);
    expect(up).toEqual(expect.arrayContaining([ids.booking, ids.direct, ids.both]));
    expect(up.filter((id) => id === ids.both)).toHaveLength(1);
    expect(new Set(up).size).toBe(up.length);
    for (const excluded of [ids.canceledUpcoming, ids.deleted, ids.foreign, ids.unrelated]) {
      expect(up).not.toContain(excluded);
    }
    expect(past.map((e) => e.id)).toEqual([ids.past]);
  });

  it("another organization's context never sees this contact's meetings", async () => {
    const otherCtx = { orgId: ids.other!, userId: ids.viewer!, role: "OWNER" } as never;
    const { upcoming } = await getEntityEvents(otherCtx, { contactId: ids.contact });
    expect(upcoming.map((e) => e.id)).toEqual([ids.foreign]);
  });

  it("the staging case renders: the attendee-linked 09:00 Helsinki booking shows as 9:00", async () => {
    const html = renderToStaticMarkup(await EntityMeetings({ ctx: ctx(), contactId: ids.contact }));
    expect(html).toContain("Public booking");
    expect(html).toMatch(/9:00/);
    expect(html).not.toContain(messages.calendar.noMeetings);
  });
});
