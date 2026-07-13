import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";

const { unscopedMock, txMock, auditMock, emitMock, issueTokenMock } = vi.hoisted(() => {
  const txMock = {
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
  };
});

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: vi.fn(),
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: emitMock }));
vi.mock("@/server/services/booking-tokens", () => ({
  issueToken: issueTokenMock,
  invalidateBookingTokens: vi.fn(async () => undefined),
  resolveToken: vi.fn(),
  consumeToken: vi.fn(async () => undefined),
}));

import { BookingError, createPublicBooking, getPublicSlots } from "@/server/services/booking";

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

  it("double-booking protection: transaction re-check wins races", async () => {
    // Slot appears free during availability computation…
    unscopedMock.calendarEvent.findMany.mockResolvedValue([]);
    // …but a concurrent booking committed before our transaction re-check.
    txMock.calendarEvent.findFirst.mockResolvedValue({ id: "concurrent-evt" });
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(txMock.booking.create).not.toHaveBeenCalled();
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

describe("BookingError typing", () => {
  it("exposes machine-readable codes", () => {
    const e = new BookingError("x", "slot_taken");
    expect(e.code).toBe("slot_taken");
    expect(e.name).toBe("BookingError");
  });
});
