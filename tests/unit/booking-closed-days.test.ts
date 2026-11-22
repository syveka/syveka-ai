import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";
import { closedWeekdays } from "@/lib/business-dna/opening-hours";

/**
 * Policy A: a weekday Business DNA explicitly marks closed has no bookable
 * slots, even when the availability schedule has a rule for it. Unset hours
 * (null, missing, no entry for the day) block nothing. Existing bookings are
 * never touched and can still be canceled.
 */

const { unscopedMock, txMock, tenantDbMock, dnaFindFirstMock, resolveTokenMock } = vi.hoisted(
  () => {
    const txMock = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => [{ role: "OWNER", id: "bt-1" }]),
      calendarEvent: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      contact: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
      eventAttendee: { create: vi.fn(), findFirst: vi.fn() },
      booking: {
        count: vi.fn(async () => 0),
        findFirst: vi.fn(async () => null),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(),
      },
      activity: { create: vi.fn() },
      reminder: { updateMany: vi.fn(async () => ({ count: 0 })) },
      bookingToken: { updateMany: vi.fn() },
    };
    return {
      txMock,
      unscopedMock: {
        bookingType: { findFirst: vi.fn() },
        organizationMember: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
        availabilitySchedule: { findFirst: vi.fn(async () => null) },
        calendarEvent: { findMany: vi.fn(async () => []) },
        $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
      },
      tenantDbMock: vi.fn(),
      dnaFindFirstMock: vi.fn(),
      resolveTokenMock: vi.fn(),
    };
  },
);

vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: unscopedMock, tenantDb: tenantDbMock }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/booking-tokens", () => ({
  issueToken: vi.fn(async () => "raw-manage-token"),
  invalidateBookingTokens: vi.fn(async () => undefined),
  resolveToken: resolveTokenMock,
  consumeTokenAtomic: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: vi.fn(async () => undefined),
}));

import {
  cancelBookingViaToken,
  createPublicBooking,
  getPublicSlots,
  rescheduleBookingViaToken,
} from "@/server/services/booking";

const HOUR = 60;
const nineToFive = (weekday: number) => ({ weekday, startMinute: 9 * HOUR, endMinute: 17 * HOUR });

// Monday to Friday 09:00-17:00 rules in Helsinki (UTC+2 in February).
function schedule(rules = [1, 2, 3, 4, 5].map(nineToFive)) {
  return { id: "sched-1", timezone: "Europe/Helsinki", rules, overrides: [] };
}

function bookingType(overrides: Record<string, unknown> = {}) {
  return {
    id: "bt-1",
    organizationId: "org-a",
    ownerId: "owner-1",
    slug: "intro-call",
    name: "Intro call",
    durationMinutes: 60,
    durationOptions: [60],
    location: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxWindowDays: 60,
    requiresConsent: false,
    isActive: true,
    deletedAt: null,
    schedule: schedule(),
    organization: { id: "org-a", name: "Acme", slug: "acme", logoUrl: null },
    ...overrides,
  };
}

// Monday 2026-02-02 and Tuesday 2026-02-03, 10:00 Helsinki.
const MONDAY_10 = "2026-02-02T08:00:00.000Z";
const TUESDAY_10 = "2026-02-03T08:00:00.000Z";

function slotsBetween(from: string, to: string) {
  return getPublicSlots({
    orgSlug: "acme",
    typeSlug: "intro-call",
    from: new Date(from),
    to: new Date(to),
  }).then(({ slots }) => slots.map((s) => s.toISOString()));
}

// Helsinki calendar days, as UTC bounds.
const tuesdaySlots = () => slotsBetween("2026-02-02T22:00:00Z", "2026-02-03T22:00:00Z");
const mondaySlots = () => slotsBetween("2026-02-01T22:00:00Z", "2026-02-02T22:00:00Z");

function storedHours(openingHours: unknown) {
  dnaFindFirstMock.mockResolvedValue({ openingHours });
}

const TUESDAY_CLOSED = {
  monday: { closed: false, open: "09:00", close: "17:00" },
  tuesday: { closed: true },
};

function input(overrides: Partial<PublicBookingInput> = {}): PublicBookingInput {
  return {
    startsAt: TUESDAY_10,
    timezone: "Europe/Helsinki",
    name: "Guest One",
    email: "guest@example.com",
    consent: true,
    ...overrides,
  } as PublicBookingInput;
}

function existingBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk-old",
    organizationId: "org-a",
    bookingTypeId: "bt-1",
    eventId: "evt-old",
    status: "CONFIRMED",
    guestName: "Guest One",
    guestEmail: "guest@example.com",
    guestPhone: null,
    guestCompany: null,
    guestNotes: null,
    guestTimezone: "Europe/Helsinki",
    guestLocale: "EN",
    consentAt: null,
    startsAt: new Date(MONDAY_10),
    endsAt: new Date(new Date(MONDAY_10).getTime() + 60 * 60_000),
    bookingType: bookingType(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-01T10:00:00Z"));
  unscopedMock.bookingType.findFirst.mockResolvedValue(bookingType());
  tenantDbMock.mockReturnValue({ businessDNA: { findFirst: dnaFindFirstMock } });
  dnaFindFirstMock.mockResolvedValue(null);
  txMock.calendarEvent.findFirst.mockResolvedValue(null);
  txMock.calendarEvent.findMany.mockResolvedValue([]);
  txMock.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
  txMock.calendarEvent.update.mockResolvedValue({});
  txMock.contact.findFirst.mockResolvedValue(null);
  txMock.contact.findMany.mockResolvedValue([]);
  txMock.contact.create.mockResolvedValue({ id: "contact-new" });
  txMock.eventAttendee.create.mockResolvedValue({});
  txMock.eventAttendee.findFirst.mockResolvedValue(null);
  txMock.bookingToken.updateMany.mockResolvedValue({ count: 1 });
  txMock.booking.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "bk-1",
    organizationId: "org-a",
    ...args.data,
  }));
  txMock.activity.create.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Business DNA closed days", () => {
  it("a Tuesday closed in Business DNA has no public slots, even with a Tuesday schedule rule", async () => {
    storedHours({ tuesday: { closed: true } });
    expect(await tuesdaySlots()).toEqual([]);
  });

  it("reads the closed days of the booking type's own organization", async () => {
    await tuesdaySlots();
    expect(tenantDbMock).toHaveBeenCalledWith("org-a");
  });

  it("an open day keeps exactly the slots it has without Business DNA", async () => {
    const before = await mondaySlots();
    expect(before).toHaveLength(8);
    storedHours(TUESDAY_CLOSED);
    expect(await mondaySlots()).toEqual(before);
  });

  it("all seven days closed: no slots anywhere", async () => {
    storedHours(
      Object.fromEntries(
        ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(
          (day) => [day, { closed: true }],
        ),
      ),
    );
    unscopedMock.bookingType.findFirst.mockResolvedValue(
      bookingType({ schedule: schedule([0, 1, 2, 3, 4, 5, 6].map(nineToFive)) }),
    );
    expect(await slotsBetween("2026-02-01T22:00:00Z", "2026-02-15T22:00:00Z")).toEqual([]);
  });

  it("the closed day is judged in the schedule timezone, not UTC", async () => {
    // Tuesday 23:00-24:00 and Wednesday 00:00-01:00 Helsinki: both are Tuesday in UTC.
    const tuesdayLate = { weekday: 2, startMinute: 23 * HOUR, endMinute: 24 * HOUR };
    const wednesdayEarly = { weekday: 3, startMinute: 0, endMinute: HOUR };
    unscopedMock.bookingType.findFirst.mockResolvedValue(
      bookingType({ schedule: schedule([tuesdayLate, wednesdayEarly]) }),
    );
    const window = () => slotsBetween("2026-02-03T00:00:00Z", "2026-02-04T12:00:00Z");
    const TUESDAY_23_LOCAL = "2026-02-03T21:00:00.000Z";
    const WEDNESDAY_00_LOCAL = "2026-02-03T22:00:00.000Z";
    expect(await window()).toEqual([TUESDAY_23_LOCAL, WEDNESDAY_00_LOCAL]);

    storedHours({ tuesday: { closed: true } });
    expect(await window()).toEqual([WEDNESDAY_00_LOCAL]);

    storedHours({ wednesday: { closed: true } });
    expect(await window()).toEqual([TUESDAY_23_LOCAL]);
  });

  it("a date override cannot reopen a closed weekday", async () => {
    unscopedMock.bookingType.findFirst.mockResolvedValue(
      bookingType({
        schedule: {
          ...schedule(),
          overrides: [
            {
              date: new Date("2026-02-03T00:00:00Z"),
              startMinute: 10 * HOUR,
              endMinute: 12 * HOUR,
              isUnavailable: false,
            },
          ],
        },
      }),
    );
    storedHours({ tuesday: { closed: true } });
    expect(await tuesdaySlots()).toEqual([]);
  });

  describe("unset hours block nothing", () => {
    it.each([
      ["no Business DNA profile", null],
      ["openingHours JSON null", { openingHours: null }],
      ["openingHours missing", {}],
      ["no entry for Tuesday", { openingHours: { monday: { closed: true } } }],
      [
        "Tuesday open",
        { openingHours: { tuesday: { closed: false, open: "09:00", close: "17:00" } } },
      ],
      ["a malformed Tuesday entry", { openingHours: { tuesday: "closed" } }],
    ])("%s", async (_label, profile) => {
      const withoutDna = await tuesdaySlots();
      expect(withoutDna).toHaveLength(8);
      dnaFindFirstMock.mockResolvedValue(profile);
      expect(await tuesdaySlots()).toEqual(withoutDna);
    });
  });

  it("creating a booking on a closed day is refused, with nothing written", async () => {
    storedHours(TUESDAY_CLOSED);
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "invalid_slot" });
    expect(unscopedMock.$transaction).not.toHaveBeenCalled();
    expect(txMock.booking.create).not.toHaveBeenCalled();
  });

  it("a page loaded while Tuesday was open cannot book it after the day is closed", async () => {
    // The guest's page listed the slot ...
    expect(await tuesdaySlots()).toContain(TUESDAY_10);
    // ... then the business marked Tuesday closed before the guest submitted.
    storedHours(TUESDAY_CLOSED);
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "invalid_slot" });
    expect(txMock.booking.create).not.toHaveBeenCalled();
  });

  it("an open day still books while another day is closed", async () => {
    storedHours(TUESDAY_CLOSED);
    const result = await createPublicBooking({
      orgSlug: "acme",
      typeSlug: "intro-call",
      input: input({ startsAt: MONDAY_10 }),
    });
    expect(result.booking.id).toBe("bk-1");
  });

  describe("existing bookings", () => {
    it("rescheduling into a closed day is refused, and the booking is not moved", async () => {
      resolveTokenMock.mockResolvedValue({
        id: "token-1",
        purpose: "RESCHEDULE",
        booking: existingBooking(),
      });
      storedHours(TUESDAY_CLOSED);
      await expect(rescheduleBookingViaToken("raw-token", TUESDAY_10)).rejects.toMatchObject({
        code: "invalid_slot",
      });
      expect(unscopedMock.$transaction).not.toHaveBeenCalled();
      expect(txMock.booking.updateMany).not.toHaveBeenCalled();
    });

    it("a CONFIRMED booking on a day that is now closed can still be canceled", async () => {
      const onClosedDay = existingBooking({
        startsAt: new Date(TUESDAY_10),
        endsAt: new Date(new Date(TUESDAY_10).getTime() + 60 * 60_000),
      });
      resolveTokenMock.mockResolvedValue({
        id: "token-1",
        purpose: "CANCEL",
        booking: onClosedDay,
      });
      txMock.booking.findUniqueOrThrow.mockResolvedValue(onClosedDay);
      storedHours(TUESDAY_CLOSED);

      const result = await cancelBookingViaToken("raw-token", "closed that day");

      expect(result.id).toBe("bk-old");
      expect(txMock.booking.updateMany).toHaveBeenCalledWith({
        where: { id: "bk-old", status: { notIn: ["CANCELED", "RESCHEDULED"] } },
        data: expect.objectContaining({ status: "CANCELED" }),
      });
    });
  });
});

describe("closedWeekdays", () => {
  it("maps explicitly closed days to calendar weekdays (0 = Sunday)", () => {
    expect(
      closedWeekdays({
        monday: { closed: true },
        tuesday: { closed: false, open: "09:00", close: "17:00" },
        sunday: { closed: true },
      }),
    ).toEqual([1, 0]);
  });

  it.each([null, undefined, "closed", [], {}, { tuesday: null }, { tuesday: { closed: "yes" } }])(
    "treats %j as no closed day",
    (raw) => {
      expect(closedWeekdays(raw)).toEqual([]);
    },
  );
});
