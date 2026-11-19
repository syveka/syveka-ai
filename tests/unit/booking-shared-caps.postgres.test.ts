import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type * as BookingService from "@/server/services/booking";
import type * as BookingTokens from "@/server/services/booking-tokens";

/**
 * The real createPublicBooking() and rescheduleBookingViaToken() against a real
 * Postgres with the full migration history: real Prisma queries, the real
 * organization advisory lock, the real booking-token claims. Only external
 * effects are mocked (audit, workflow events, the CRM contact event).
 *
 * The shared booking caps (page per hour, organization per day) are counted
 * from the bookings table inside the booking transaction, under the
 * organization calendar lock. With exactly one unit of the organization cap
 * left, a mixed concurrent batch of new bookings and reschedules must let
 * exactly one through and refuse every other call with "booking_cap",
 * leaving no trace of the refused ones.
 *
 * The app's Prisma pool is max 1 per serverless instance, so concurrent calls
 * in one process would be serialized by the pool, not the lock. This test
 * uses a larger pool to stand in for separate instances.
 *
 * Skipped unless SEAT_LIMIT_PG_URL points at a scratch database prepared as
 * in CI: tests/migrations/supabase-compatibility.sql, then
 * `prisma migrate deploy`. Synthetic organizations only, unique per run.
 */

const PG_URL = process.env.SEAT_LIMIT_PG_URL;

const holder = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by the public booking path");
  },
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/contacts", () => ({
  emitContactCreated: vi.fn(async () => undefined),
}));

type Where = { where: object };
type Db = {
  organization: {
    create: (a: object) => Promise<{ id: string; slug: string }>;
    deleteMany: (a: Where) => Promise<unknown>;
  };
  user: {
    create: (a: object) => Promise<{ id: string }>;
    deleteMany: (a: Where) => Promise<unknown>;
  };
  organizationMember: { create: (a: object) => Promise<unknown> };
  availabilitySchedule: { create: (a: object) => Promise<{ id: string }> };
  bookingType: { create: (a: object) => Promise<{ id: string }> };
  calendarEvent: {
    create: (a: object) => Promise<{ id: string }>;
    count: (a: Where) => Promise<number>;
    findUniqueOrThrow: (a: Where) => Promise<{ status: string; startsAt: Date }>;
  };
  booking: {
    create: (a: object) => Promise<{ id: string }>;
    createMany: (a: object) => Promise<unknown>;
    count: (a: Where) => Promise<number>;
    findUniqueOrThrow: (a: Where) => Promise<{ status: string; startsAt: Date }>;
  };
  bookingToken: {
    findUniqueOrThrow: (a: Where) => Promise<{ usedAt: Date | null }>;
  };
  $disconnect: () => Promise<void>;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SLOT_MINUTES = 30;

describe.skipIf(!PG_URL)("shared booking caps under concurrency on real Postgres", () => {
  let db: Db;
  let booking: typeof BookingService;
  let tokens: typeof BookingTokens;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
    ]);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 8 }),
    }) as unknown as Db;
    holder.client = db;
    booking = await import("@/server/services/booking");
    tokens = await import("@/server/services/booking-tokens");
  });

  afterAll(async () => {
    try {
      // Everything the test wrote hangs off these organizations (ON DELETE CASCADE).
      if (orgIds.length > 0) await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      if (userIds.length > 0) await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await db?.$disconnect();
    }
  });

  /** Midnight UTC three days ahead: inside every booking window, past any minimum notice. */
  const dayStart = () => {
    const now = Date.now();
    return new Date(Math.floor(now / DAY_MS) * DAY_MS + 3 * DAY_MS);
  };
  /** Free slot number `n` of that day (30-minute grid, 00:00 UTC onward). */
  const slot = (n: number) => new Date(dayStart().getTime() + n * SLOT_MINUTES * MINUTE_MS);

  /**
   * One organization whose cap has exactly `unitsLeft` units left in the 24 h
   * window. Its counted bookings are `reschedulable` existing CONFIRMED future
   * bookings on page A (each with a RESCHEDULE token) plus canceled filler rows
   * created within the last hour on page B, so page A's hourly cap never binds.
   */
  async function seed(params: { unitsLeft: number; reschedulable: number }) {
    const { PUBLIC_BOOKING_ATTEMPTS_PER_ORG_PER_DAY: orgCap } = booking;
    const org = await db.organization.create({
      data: { name: "Synthetic booking cap test", slug: `booking-cap-${randomUUID()}` },
    });
    orgIds.push(org.id);
    const owner = await db.user.create({
      data: { id: randomUUID(), email: `owner-${randomUUID()}@example.test` },
    });
    userIds.push(owner.id);
    await db.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: "OWNER" },
    });

    // Open every day, all day, in UTC, so slot generation depends on no local calendar.
    const schedule = await db.availabilitySchedule.create({
      data: {
        organizationId: org.id,
        userId: owner.id,
        name: "Always open",
        timezone: "UTC",
        isDefault: true,
        rules: {
          create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 0,
            endMinute: 24 * 60,
          })),
        },
      },
    });
    const typeData = (slug: string) => ({
      organizationId: org.id,
      ownerId: owner.id,
      scheduleId: schedule.id,
      slug,
      name: `Synthetic ${slug}`,
      durationMinutes: SLOT_MINUTES,
      durationOptions: [SLOT_MINUTES],
      minNoticeMinutes: 0,
      maxWindowDays: 60,
      requiresConsent: false,
    });
    const pageA = await db.bookingType.create({ data: typeData("page-a") });
    const pageB = await db.bookingType.create({ data: typeData("page-b") });

    // Existing future bookings to reschedule, far from the slots the race asks for.
    const existing: Array<{ bookingId: string; eventId: string; startsAt: Date; token: string }> =
      [];
    for (let i = 0; i < params.reschedulable; i++) {
      const startsAt = slot(30 + i);
      const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * MINUTE_MS);
      const event = await db.calendarEvent.create({
        data: {
          organizationId: org.id,
          createdById: owner.id,
          ownerId: owner.id,
          title: `Synthetic existing ${i}`,
          timezone: "UTC",
          startsAt,
          endsAt,
          source: "BOOKING",
        },
      });
      const row = await db.booking.create({
        data: {
          organizationId: org.id,
          bookingTypeId: pageA.id,
          eventId: event.id,
          guestName: `Existing Guest ${i}`,
          guestEmail: `existing-${i}-${randomUUID()}@example.test`,
          guestTimezone: "UTC",
          startsAt,
          endsAt,
        },
      });
      const token = await tokens.issueToken(row.id, "RESCHEDULE", undefined, endsAt);
      existing.push({ bookingId: row.id, eventId: event.id, startsAt, token });
    }

    const fillers = orgCap - params.unitsLeft - params.reschedulable;
    const createdAt = new Date(Date.now() - 30 * MINUTE_MS);
    const past = new Date(Date.now() - 2 * DAY_MS);
    await db.booking.createMany({
      data: Array.from({ length: fillers }, (_, i) => ({
        organizationId: org.id,
        bookingTypeId: pageB.id,
        guestName: `Filler ${i}`,
        guestEmail: `filler-${i}@example.test`,
        status: "CANCELED",
        startsAt: past,
        endsAt: new Date(past.getTime() + SLOT_MINUTES * MINUTE_MS),
        createdAt,
      })),
    });
    await expect(db.booking.count({ where: { organizationId: org.id } })).resolves.toBe(
      orgCap - params.unitsLeft,
    );

    return { orgId: org.id, orgSlug: org.slug, existing };
  }

  const guest = (startsAt: Date, label: string) => ({
    startsAt: startsAt.toISOString(),
    timezone: "UTC",
    name: `Guest ${label}`,
    email: `guest-${label}-${randomUUID()}@example.test`,
    consent: true,
  });

  const counts = async (orgId: string) => ({
    bookings: await db.booking.count({ where: { organizationId: orgId } }),
    events: await db.calendarEvent.count({ where: { organizationId: orgId } }),
  });

  async function assertUntouched(existing: {
    bookingId: string;
    eventId: string;
    startsAt: Date;
    token: string;
  }) {
    const old = await db.booking.findUniqueOrThrow({ where: { id: existing.bookingId } });
    expect(old.status).toBe("CONFIRMED");
    expect(old.startsAt.getTime()).toBe(existing.startsAt.getTime());
    const event = await db.calendarEvent.findUniqueOrThrow({ where: { id: existing.eventId } });
    expect(event.status).toBe("CONFIRMED");
    expect(event.startsAt.getTime()).toBe(existing.startsAt.getTime());
    const token = await db.bookingToken.findUniqueOrThrow({
      where: { tokenHash: tokens.hashToken(existing.token) },
    });
    expect(token.usedAt).toBeNull();
  }

  it("lets exactly one of a mixed concurrent batch take the last unit of the organization cap", async () => {
    const { BookingError } = booking;
    const { orgId, orgSlug, existing } = await seed({ unitsLeft: 1, reschedulable: 2 });
    const before = await counts(orgId);
    expect(before.bookings).toBe(booking.PUBLIC_BOOKING_ATTEMPTS_PER_ORG_PER_DAY - 1);

    const creates = [0, 1, 2].map((n) =>
      booking.createPublicBooking({
        orgSlug,
        typeSlug: "page-a",
        input: guest(slot(n), `create-${n}`),
      }),
    );
    const reschedules = existing.map((e, i) =>
      booking.rescheduleBookingViaToken(e.token, slot(10 + i).toISOString()),
    );
    const calls = [...creates, ...reschedules];
    const results = await Promise.allSettled(calls);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(calls.length - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(BookingError);
      expect(r.reason).toMatchObject({ code: "booking_cap" });
    }

    // One booking and one calendar event were written, by the winner only.
    const after = await counts(orgId);
    expect(after.bookings).toBe(before.bookings + 1);
    expect(after.events).toBe(before.events + 1);

    // Every refused reschedule left its old booking, event and token alone.
    for (const [i, e] of existing.entries()) {
      if (results[creates.length + i]!.status === "rejected") await assertUntouched(e);
    }
  }, 30_000);

  it("refuses a create and a reschedule once the organization cap is used up, writing nothing", async () => {
    const { BookingError } = booking;
    const { orgId, orgSlug, existing } = await seed({ unitsLeft: 0, reschedulable: 1 });
    const before = await counts(orgId);
    expect(before.bookings).toBe(booking.PUBLIC_BOOKING_ATTEMPTS_PER_ORG_PER_DAY);

    const create = booking.createPublicBooking({
      orgSlug,
      typeSlug: "page-a",
      input: guest(slot(0), "create"),
    });
    await expect(create).rejects.toBeInstanceOf(BookingError);
    await expect(create).rejects.toMatchObject({ code: "booking_cap" });

    const reschedule = booking.rescheduleBookingViaToken(
      existing[0]!.token,
      slot(10).toISOString(),
    );
    await expect(reschedule).rejects.toBeInstanceOf(BookingError);
    await expect(reschedule).rejects.toMatchObject({ code: "booking_cap" });

    await expect(counts(orgId)).resolves.toEqual(before);
    await assertUntouched(existing[0]!);
  }, 30_000);
});
