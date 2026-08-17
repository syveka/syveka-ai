import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";

const { unscopedMock, txMock, auditMock, emitMock, issueTokenMock, resolveTokenMock } = vi.hoisted(
  () => {
    const txMock = {
      $executeRaw: vi.fn(async () => 0),
      calendarEvent: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      contact: { findFirst: vi.fn() },
      eventAttendee: { create: vi.fn() },
      booking: { create: vi.fn(), update: vi.fn() },
      activity: { create: vi.fn() },
      reminder: { updateMany: vi.fn() },
    };
    return {
      txMock,
      unscopedMock: {
        bookingType: { findFirst: vi.fn() },
        availabilitySchedule: { findFirst: vi.fn(async () => null) },
        calendarEvent: {
          findMany: vi.fn(async (): Promise<Array<{ startsAt: Date; endsAt: Date }>> => []),
        },
        $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
      },
      auditMock: vi.fn(async () => undefined),
      emitMock: vi.fn(async () => undefined),
      issueTokenMock: vi.fn(async () => "raw-manage-token"),
      resolveTokenMock: vi.fn(),
    };
  },
);

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: vi.fn(),
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: emitMock }));
vi.mock("@/server/services/booking-tokens", () => ({
  issueToken: issueTokenMock,
  invalidateBookingTokens: vi.fn(async () => undefined),
  resolveToken: resolveTokenMock,
  consumeToken: vi.fn(async () => undefined),
}));

import {
  BookingError,
  createPublicBooking,
  getPublicSlots,
  rescheduleBookingViaToken,
} from "@/server/services/booking";

// Booking type: Mon–Fri 09–17 Helsinki fallback schedule (schedule = null).
function bookingType(overrides: Record<string, unknown> = {}) {
  return {
    id: "bt-1",
    organizationId: "org-a",
    ownerId: "owner-1",
    slug: "intro-call",
    name: "Intro call",
    durationMinutes: 60,
    durationOptions: [60],
    locationType: "VIDEO",
    location: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxWindowDays: 60,
    requiresConsent: true,
    confirmationMessage: null,
    isActive: true,
    deletedAt: null,
    schedule: null,
    organization: { id: "org-a", name: "Acme", slug: "acme", logoUrl: null },
    ...overrides,
  };
}

// Monday 2026-02-02, 09:00 Helsinki = 07:00Z (winter).
const VALID_START = "2026-02-02T07:00:00.000Z";

function input(overrides: Partial<PublicBookingInput> = {}): PublicBookingInput {
  return {
    startsAt: VALID_START,
    timezone: "Europe/Helsinki",
    name: "Guest One",
    email: "guest@example.com",
    consent: true,
    ...overrides,
  } as PublicBookingInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-01T10:00:00Z"));
  unscopedMock.bookingType.findFirst.mockResolvedValue(bookingType());
  unscopedMock.availabilitySchedule.findFirst.mockResolvedValue(null);
  unscopedMock.calendarEvent.findMany.mockResolvedValue([]);
  txMock.calendarEvent.findFirst.mockResolvedValue(null); // no conflict inside tx
  txMock.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
  txMock.contact.findFirst.mockResolvedValue(null);
  txMock.eventAttendee.create.mockResolvedValue({});
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

describe("public slots", () => {
  it("computes slots from the built-in fallback schedule", async () => {
    const { slots, timezone } = await getPublicSlots({
      orgSlug: "acme",
      typeSlug: "intro-call",
      from: new Date("2026-02-02T00:00:00Z"),
      to: new Date("2026-02-03T00:00:00Z"),
    });
    expect(timezone).toBe("Europe/Helsinki");
    expect(slots.map((s) => s.toISOString())).toContain(VALID_START);
  });

  it("404s for unknown booking pages", async () => {
    unscopedMock.bookingType.findFirst.mockResolvedValue(null);
    await expect(
      getPublicSlots({
        orgSlug: "acme",
        typeSlug: "nope",
        from: new Date(),
        to: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects durations that are not offered", async () => {
    await expect(
      getPublicSlots({
        orgSlug: "acme",
        typeSlug: "intro-call",
        from: new Date(),
        to: new Date(Date.now() + 86_400_000),
        durationMinutes: 45,
      }),
    ).rejects.toMatchObject({ code: "invalid_duration" });
  });
});

describe("createPublicBooking", () => {
  it("books a valid slot: event + attendee + booking + CRM activity + token", async () => {
    const result = await createPublicBooking({
      orgSlug: "acme",
      typeSlug: "intro-call",
      input: input(),
    });
    expect(result.booking.id).toBe("bk-1");
    expect(result.manageToken).toBe("raw-manage-token");
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: "org-a", source: "BOOKING" }),
      }),
    );
    expect(txMock.eventAttendee.create).toHaveBeenCalled();
    expect(txMock.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "MEETING", organizationId: "org-a" }),
      }),
    );
    expect(emitMock).toHaveBeenCalledWith("org-a", "booking.created", expect.anything());
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "booking.create" }),
    );
  });

  it("links the guest to an existing CRM contact by email", async () => {
    txMock.contact.findFirst.mockResolvedValue({ id: "contact-9" });
    await createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() });
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: "contact-9" }) }),
    );
  });

  it("enforces consent when the booking type requires it", async () => {
    await expect(
      createPublicBooking({
        orgSlug: "acme",
        typeSlug: "intro-call",
        input: input({ consent: false }),
      }),
    ).rejects.toMatchObject({ code: "consent_required" });
    expect(unscopedMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects times that are not offered slots (out of hours)", async () => {
    await expect(
      createPublicBooking({
        orgSlug: "acme",
        typeSlug: "intro-call",
        input: input({ startsAt: "2026-02-02T02:00:00.000Z" }), // 04:00 local
      }),
    ).rejects.toMatchObject({ code: "invalid_slot" });
  });

  it("rejects unknown guest timezones", async () => {
    await expect(
      createPublicBooking({
        orgSlug: "acme",
        typeSlug: "intro-call",
        input: input({ timezone: "Nowhere/Here" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_timezone" });
  });

  it("re-check guard: rejects when the in-transaction conflict query finds a row", async () => {
    // This proves the *guard clause* fires correctly when assertSlotStillFree's
    // query returns a conflict - it does NOT prove concurrency safety, since a
    // mocked single-threaded transaction can't reproduce two real Postgres
    // transactions racing under READ COMMITTED. See the "serializes concurrent
    // booking attempts" test below for the actual concurrency-safety regression
    // coverage (the advisory lock call), and
    // tests/integration/booking-concurrency.sh for a real-Postgres proof.
    unscopedMock.calendarEvent.findMany.mockResolvedValue([]);
    txMock.calendarEvent.findFirst.mockResolvedValue({ id: "concurrent-evt" });
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(txMock.booking.create).not.toHaveBeenCalled();
  });

  it("serializes concurrent booking attempts: acquires the owner-calendar advisory lock before checking/writing", async () => {
    const callOrder: string[] = [];
    txMock.$executeRaw.mockImplementationOnce(async () => {
      callOrder.push("lock");
      return 0;
    });
    txMock.calendarEvent.findFirst.mockImplementationOnce(async () => {
      callOrder.push("conflict-check");
      return null;
    });
    txMock.calendarEvent.create.mockImplementationOnce(async () => {
      callOrder.push("create-event");
      return { id: "evt-1" };
    });

    await createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() });

    // The lock must be the *first* statement in the transaction: taken before the
    // conflict re-check and before any write, so a second concurrent transaction
    // blocks here instead of racing assertSlotStillFree's SELECT under READ
    // COMMITTED (src/server/services/booking.ts's lockOwnerCalendarForBooking).
    expect(callOrder).toEqual(["lock", "conflict-check", "create-event"]);
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("busy owner calendars remove the slot up front", async () => {
    unscopedMock.calendarEvent.findMany.mockResolvedValue([
      { startsAt: new Date("2026-02-02T07:00:00Z"), endsAt: new Date("2026-02-02T08:00:00Z") },
    ]);
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "invalid_slot" });
  });
});

describe("rescheduleBookingViaToken", () => {
  function oldBooking(overrides: Record<string, unknown> = {}) {
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
      consentAt: new Date("2026-01-01T00:00:00Z"),
      startsAt: new Date(VALID_START),
      endsAt: new Date(new Date(VALID_START).getTime() + 60 * 60_000),
      ...overrides,
    };
  }

  beforeEach(() => {
    resolveTokenMock.mockResolvedValue({
      id: "token-1",
      purpose: "RESCHEDULE",
      booking: oldBooking(),
    });
    txMock.calendarEvent.update.mockResolvedValue({});
    txMock.reminder.updateMany.mockResolvedValue({ count: 0 });
    txMock.booking.update.mockResolvedValue({});
  });

  // Tuesday 2026-02-03, 10:00 Helsinki = 08:00Z (winter).
  const NEW_START = "2026-02-03T08:00:00.000Z";

  it("serializes concurrent reschedule attempts: acquires the owner-calendar advisory lock before checking/writing", async () => {
    const callOrder: string[] = [];
    txMock.$executeRaw.mockImplementationOnce(async () => {
      callOrder.push("lock");
      return 0;
    });
    txMock.calendarEvent.findFirst.mockImplementationOnce(async () => {
      callOrder.push("conflict-check");
      return null;
    });
    txMock.calendarEvent.create.mockImplementationOnce(async () => {
      callOrder.push("create-event");
      return { id: "evt-new" };
    });

    const result = await rescheduleBookingViaToken("raw-token", NEW_START);

    expect(result.booking.id).toBe("bk-1");
    expect(callOrder).toEqual(["lock", "conflict-check", "create-event"]);
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects when the in-transaction conflict query finds a row", async () => {
    txMock.calendarEvent.findFirst.mockResolvedValue({ id: "concurrent-evt" });
    await expect(rescheduleBookingViaToken("raw-token", NEW_START)).rejects.toMatchObject({
      code: "slot_taken",
    });
    expect(txMock.booking.create).not.toHaveBeenCalled();
  });
});

describe("BookingError typing", () => {
  it("exposes machine-readable codes", () => {
    const e = new BookingError("x", "slot_taken");
    expect(e.code).toBe("slot_taken");
    expect(e.name).toBe("BookingError");
  });
});
