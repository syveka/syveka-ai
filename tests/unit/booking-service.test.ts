import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";

const {
  unscopedMock,
  txMock,
  tenantDbMock,
  auditMock,
  emitMock,
  issueTokenMock,
  resolveTokenMock,
  consumeTokenAtomicMock,
  invalidateBookingTokensMock,
  sendBookingLifecycleNotificationsMock,
  cancelBookingEventOnGoogleMock,
  pushBookingEventToGoogleMock,
} = vi.hoisted(() => {
  const txMock = {
    $executeRaw: vi.fn(async () => 0),
    calendarEvent: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    contact: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), create: vi.fn() },
    eventAttendee: { create: vi.fn() },
    booking: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(),
    },
    activity: { create: vi.fn() },
    reminder: { updateMany: vi.fn() },
    bookingToken: { updateMany: vi.fn() },
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
    tenantDbMock: vi.fn(),
    auditMock: vi.fn(async () => undefined),
    emitMock: vi.fn(async () => undefined),
    issueTokenMock: vi.fn(async () => "raw-manage-token"),
    resolveTokenMock: vi.fn(),
    consumeTokenAtomicMock: vi.fn(async () => undefined),
    invalidateBookingTokensMock: vi.fn(async () => undefined),
    sendBookingLifecycleNotificationsMock: vi.fn(async () => undefined),
    cancelBookingEventOnGoogleMock: vi.fn(async () => "not_applicable" as const),
    pushBookingEventToGoogleMock: vi.fn(async () => "not_applicable" as const),
  };
});

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: tenantDbMock,
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: emitMock }));
vi.mock("@/server/services/booking-tokens", () => ({
  issueToken: issueTokenMock,
  invalidateBookingTokens: invalidateBookingTokensMock,
  resolveToken: resolveTokenMock,
  consumeTokenAtomic: consumeTokenAtomicMock,
  BookingTokenError: class BookingTokenError extends Error {
    constructor(
      message: string,
      public readonly code: "invalid" | "expired" | "used",
    ) {
      super(message);
      this.name = "BookingTokenError";
    }
  },
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: sendBookingLifecycleNotificationsMock,
}));
vi.mock("@/server/services/calendar-sync", () => ({
  cancelBookingEventOnGoogle: cancelBookingEventOnGoogleMock,
  pushBookingEventToGoogle: pushBookingEventToGoogleMock,
}));

import {
  BookingError,
  cancelBookingAsOwner,
  cancelBookingViaToken,
  createPublicBooking,
  createVoiceBooking,
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
  txMock.contact.create.mockResolvedValue({ id: "contact-new" });
  txMock.eventAttendee.create.mockResolvedValue({});
  txMock.bookingToken.updateMany.mockResolvedValue({ count: 1 }); // token claim succeeds by default
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
    expect(emitMock).toHaveBeenCalledWith("org-a", "booking.created", expect.anything(), "bk-1");
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
    expect(txMock.contact.create).not.toHaveBeenCalled();
  });

  it("creates a new CRM contact (as a LEAD) for a brand-new guest, splitting name into first/last", async () => {
    // Regression test for the First Customer Readiness audit finding: a
    // brand-new guest's public booking previously never created a Contact
    // at all (findFirst-only, contactId stayed null everywhere).
    txMock.contact.findFirst.mockResolvedValue(null);
    await createPublicBooking({
      orgSlug: "acme",
      typeSlug: "intro-call",
      input: input({ name: "Jane Customer", phone: "+358401234567" }),
    });
    expect(txMock.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          firstName: "Jane",
          lastName: "Customer",
          email: "guest@example.com",
          phone: "+358401234567",
          source: "public-booking",
        }),
      }),
    );
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: "contact-new" }) }),
    );
    expect(txMock.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: "contact-new" }) }),
    );
  });

  it("handles a single-word guest name without a lastName", async () => {
    txMock.contact.findFirst.mockResolvedValue(null);
    await createPublicBooking({
      orgSlug: "acme",
      typeSlug: "intro-call",
      input: input({ name: "Cher" }),
    });
    expect(txMock.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ firstName: "Cher", lastName: null }),
      }),
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
    // Two advisory locks are now taken per booking: lockOwnerCalendar (asserted
    // above via callOrder, first call) and lockContactEmail (PR #91 review fix
    // for the duplicate-Contact race across different booking types/owners -
    // see src/server/calendar/locks.ts and tests/integration/contact-race-concurrency.sh).
    // The Contact block runs after the event/booking write in this mock's
    // control flow, so its $executeRaw call lands on the default (unpushed)
    // implementation rather than the "Once" one - only the call count changes.
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(2);
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

describe("createVoiceBooking (P2: unified booking lifecycle - bookMeeting's voice path)", () => {
  function voiceInput(overrides: Record<string, unknown> = {}) {
    return {
      orgId: "org-a",
      actorUserId: "owner-1",
      title: "Haircut with Maria",
      startsAt: VALID_START,
      durationMinutes: 30,
      timezone: "Europe/Helsinki",
      guestName: "Maria Virtanen",
      guestEmail: "maria@example.fi",
      ...overrides,
    };
  }

  beforeEach(() => {
    unscopedMock.bookingType.findFirst.mockResolvedValue(
      bookingType({ id: "bt-ai", name: "Haircut", ownerId: "owner-1", isAiBookingDefault: true }),
    );
    txMock.calendarEvent.create.mockResolvedValue({ id: "evt-voice-1" });
    txMock.contact.findFirst.mockResolvedValue(null);
    txMock.contact.create.mockResolvedValue({ id: "contact-voice-1" });
    txMock.booking.create.mockResolvedValue({
      id: "booking-voice-1",
      startsAt: new Date(VALID_START),
    });
  });

  it("fails loudly - never guesses a BookingType - when the org has no AI-default configured", async () => {
    unscopedMock.bookingType.findFirst.mockResolvedValue(null);
    await expect(createVoiceBooking(voiceInput())).rejects.toMatchObject({
      code: "ai_booking_type_not_configured",
    });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("resolves the AI-default BookingType by isAiBookingDefault, never by guessing from a service name", async () => {
    await createVoiceBooking(voiceInput());
    expect(unscopedMock.bookingType.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-a",
          isAiBookingDefault: true,
          isActive: true,
          deletedAt: null,
        },
      }),
    );
  });

  it("books: creates a real Booking + CalendarEvent(source VOICE_AI) + EventAttendee + CRM activity, issues a manage token, audits as booking.create, emits booking.created", async () => {
    const result = await createVoiceBooking(voiceInput());

    expect(txMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          title: "Haircut with Maria",
          source: "VOICE_AI",
        }),
      }),
    );
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "maria@example.fi", name: "Maria Virtanen" }),
      }),
    );
    expect(txMock.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingTypeId: "bt-ai",
          guestName: "Maria Virtanen",
          guestEmail: "maria@example.fi",
        }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", userId: "owner-1" }),
      expect.objectContaining({ action: "booking.create", actorType: "voice_ai" }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.created",
      expect.anything(),
      "booking-voice-1",
    );
    expect(result.manageToken).toBe("raw-manage-token");
    expect(result.bookingType.ownerId).toBe("owner-1");
  });

  it("rejects a race: an org-wide conflict (same shared-calendar model bookMeeting has always used) blocks the write", async () => {
    txMock.calendarEvent.findFirst.mockResolvedValue({ id: "conflicting-evt" });
    await expect(createVoiceBooking(voiceInput())).rejects.toMatchObject({ code: "slot_taken" });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("uses a caller-supplied contactId directly after a tenancy check, skipping contact find-or-create", async () => {
    txMock.contact.findFirstOrThrow.mockResolvedValue({ id: "contact-existing" });
    await createVoiceBooking(voiceInput({ contactId: "contact-existing" }));
    expect(txMock.contact.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "contact-existing", organizationId: "org-a" },
    });
    expect(txMock.contact.findFirst).not.toHaveBeenCalled();
    expect(txMock.contact.create).not.toHaveBeenCalled();
  });

  it("rejects a contactId that does not belong to the caller's organization", async () => {
    txMock.contact.findFirstOrThrow.mockRejectedValue(new Error("No Contact found"));
    await expect(
      createVoiceBooking(voiceInput({ contactId: "cross-tenant-contact" })),
    ).rejects.toThrow();
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("matches an existing contact by guest email instead of creating a duplicate", async () => {
    txMock.contact.findFirst.mockResolvedValue({ id: "matched-contact" });
    await createVoiceBooking(voiceInput());
    expect(txMock.contact.create).not.toHaveBeenCalled();
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: "matched-contact" }) }),
    );
  });

  it("creates a new CRM contact (source voice-ai) for a brand-new caller", async () => {
    await createVoiceBooking(voiceInput({ guestPhone: "+358401234567" }));
    expect(txMock.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          email: "maria@example.fi",
          phone: "+358401234567",
          source: "voice-ai",
        }),
      }),
    );
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
    txMock.booking.updateMany.mockResolvedValue({ count: 1 });
    txMock.booking.findUniqueOrThrow.mockResolvedValue(oldBooking());
  });

  // Tuesday 2026-02-03, 10:00 Helsinki = 08:00Z (winter).
  const NEW_START = "2026-02-03T08:00:00.000Z";

  it("consumes the token INSIDE the same transaction as the mutation, before any write", async () => {
    const callOrder: string[] = [];
    consumeTokenAtomicMock.mockImplementationOnce(async () => {
      callOrder.push("consume-token");
    });
    txMock.booking.findUniqueOrThrow.mockImplementationOnce(async () => {
      callOrder.push("re-fetch-status");
      return oldBooking();
    });
    txMock.$executeRaw.mockImplementationOnce(async () => {
      callOrder.push("lock");
      return 0;
    });
    txMock.booking.updateMany.mockImplementationOnce(async () => {
      callOrder.push("cancel-old-booking");
      return { count: 1 };
    });

    await rescheduleBookingViaToken("raw-token", NEW_START);

    expect(callOrder).toEqual(["consume-token", "re-fetch-status", "lock", "cancel-old-booking"]);
  });

  it("rejects (whole transaction rolls back) when the token was already consumed by a concurrent request", async () => {
    const { BookingTokenError } = await import("@/server/services/booking-tokens");
    consumeTokenAtomicMock.mockRejectedValueOnce(
      new BookingTokenError("Token already used", "used"),
    );

    await expect(rescheduleBookingViaToken("raw-token", NEW_START)).rejects.toMatchObject({
      code: "used",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("rejects when the freshly re-read booking is already canceled (closes the pre-transaction-only status-check gap)", async () => {
    txMock.booking.findUniqueOrThrow.mockResolvedValue(oldBooking({ status: "CANCELED" }));
    await expect(rescheduleBookingViaToken("raw-token", NEW_START)).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });

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

  it("PR #92 adversarial review: loses the race to a concurrent owner-cancel (updateMany claims zero rows) - rejects BEFORE canceling the old calendar event or creating a successor", async () => {
    // Simulates a real-Postgres race found during PR #92 review: an
    // owner-cancel (which shares no lock/token with this guest-reschedule
    // path) commits between this call's freshOld read and its own guarded
    // update, so the update's WHERE clause matches zero rows. Before this
    // fix, the old booking-update here was unconditional and would have
    // silently resurrected a booking the owner just canceled.
    txMock.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(rescheduleBookingViaToken("raw-token", NEW_START)).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.calendarEvent.update).not.toHaveBeenCalled();
    expect(txMock.reminder.updateMany).not.toHaveBeenCalled();
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(txMock.booking.create).not.toHaveBeenCalled();
  });
});

describe("cancelBookingViaToken", () => {
  function confirmedBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: "bk-old",
      organizationId: "org-a",
      bookingTypeId: "bt-1",
      eventId: "evt-old",
      status: "CONFIRMED",
      guestName: "Guest One",
      guestEmail: "guest@example.com",
      startsAt: new Date(VALID_START),
      endsAt: new Date(new Date(VALID_START).getTime() + 60 * 60_000),
      bookingType: bookingType(),
      ...overrides,
    };
  }

  beforeEach(() => {
    resolveTokenMock.mockResolvedValue({
      id: "token-1",
      purpose: "CANCEL",
      booking: confirmedBooking(),
    });
    txMock.booking.findUniqueOrThrow.mockResolvedValue(confirmedBooking());
    txMock.booking.updateMany.mockResolvedValue({ count: 1 });
    txMock.calendarEvent.update.mockResolvedValue({});
    txMock.reminder.updateMany.mockResolvedValue({ count: 0 });
  });

  it("cancels a confirmed booking: consumes the token atomically, cancels the event, records CRM activity", async () => {
    const result = await cancelBookingViaToken("raw-token", "change of plans");

    expect(consumeTokenAtomicMock).toHaveBeenCalledWith(txMock, "token-1");
    // Guarded, not a blind update: excludes CANCELED/RESCHEDULED so a
    // concurrent second caller's updateMany matches zero rows instead of
    // silently re-applying every side effect below a second time (see
    // cancelBookingCore's doc comment).
    expect(txMock.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "bk-old", status: { notIn: ["CANCELED", "RESCHEDULED"] } },
      data: expect.objectContaining({ status: "CANCELED", cancelReason: "change of plans" }),
    });
    expect(txMock.calendarEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt-old" } }),
    );
    expect(txMock.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "MEETING" }) }),
    );
    expect(invalidateBookingTokensMock).toHaveBeenCalledWith("bk-old");
    expect(emitMock).toHaveBeenCalledWith("org-a", "booking.canceled", expect.anything(), "bk-old");
    expect(result.id).toBe("bk-old");
  });

  it("rejects (rolls back, no mutation) when the token was already consumed by a concurrent request", async () => {
    const { BookingTokenError } = await import("@/server/services/booking-tokens");
    consumeTokenAtomicMock.mockRejectedValueOnce(
      new BookingTokenError("Token already used", "used"),
    );

    await expect(cancelBookingViaToken("raw-token")).rejects.toMatchObject({ code: "used" });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when the freshly re-read booking is already canceled, even if the pre-fetched copy looked confirmed", async () => {
    // This is the exact gap the audit found: the OLD code checked
    // `record.booking.status` (fetched before the transaction) and never
    // re-verified inside it. Simulating a concurrent cancel having already
    // landed by the time this transaction's re-fetch runs.
    txMock.booking.findUniqueOrThrow.mockResolvedValue(confirmedBooking({ status: "CANCELED" }));
    await expect(cancelBookingViaToken("raw-token")).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("rejects canceling a booking that already started", async () => {
    txMock.booking.findUniqueOrThrow.mockResolvedValue(
      confirmedBooking({ startsAt: new Date("2026-01-01T00:00:00Z") }),
    );
    await expect(cancelBookingViaToken("raw-token")).rejects.toMatchObject({ code: "too_late" });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("PR #92 adversarial review: loses the race to a concurrent canceler (updateMany claims zero rows) - rejects, no duplicate side effects", async () => {
    txMock.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cancelBookingViaToken("raw-token")).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.calendarEvent.update).not.toHaveBeenCalled();
    expect(txMock.activity.create).not.toHaveBeenCalled();
  });
});

describe("cancelBookingAsOwner", () => {
  function confirmedBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: "bk-old",
      organizationId: "org-a",
      bookingTypeId: "bt-1",
      eventId: "evt-old",
      status: "CONFIRMED",
      guestName: "Guest One",
      guestEmail: "guest@example.com",
      startsAt: new Date(VALID_START),
      endsAt: new Date(new Date(VALID_START).getTime() + 60 * 60_000),
      bookingType: bookingType(),
      ...overrides,
    };
  }

  function ownerCtx(orgId = "org-a") {
    return {
      userId: "owner-1",
      email: "owner@test.fi",
      orgId,
      role: "OWNER" as const,
      locale: "en",
    };
  }

  beforeEach(() => {
    tenantDbMock.mockReturnValue({ booking: { findFirst: vi.fn(async () => ({ id: "bk-old" })) } });
    txMock.booking.findUniqueOrThrow.mockResolvedValue(confirmedBooking());
    txMock.booking.updateMany.mockResolvedValue({ count: 1 });
    txMock.calendarEvent.update.mockResolvedValue({});
    txMock.reminder.updateMany.mockResolvedValue({ count: 0 });
  });

  it("cancels a confirmed booking without a token: same atomic side effects as the guest path (Booking, CalendarEvent, Reminders, CRM activity)", async () => {
    const result = await cancelBookingAsOwner(ownerCtx(), "bk-old", "owner canceled by phone");

    expect(tenantDbMock).toHaveBeenCalledWith("org-a");
    // No token machinery involved - this is an authenticated, session-based cancel.
    expect(consumeTokenAtomicMock).not.toHaveBeenCalled();
    expect(txMock.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "bk-old", status: { notIn: ["CANCELED", "RESCHEDULED"] } },
      data: expect.objectContaining({
        status: "CANCELED",
        cancelReason: "owner canceled by phone",
      }),
    });
    expect(txMock.calendarEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt-old" } }),
    );
    expect(txMock.reminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "evt-old", status: "SCHEDULED" } }),
    );
    expect(txMock.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "MEETING" }) }),
    );
    expect(invalidateBookingTokensMock).toHaveBeenCalledWith("bk-old");
    expect(emitMock).toHaveBeenCalledWith("org-a", "booking.canceled", expect.anything(), "bk-old");
    // The fix for the missing-notification defect found during review: the
    // guest must get the same cancellation email the token-cancel path
    // sends (src/app/api/v1/booking/manage/[token]/route.ts).
    expect(sendBookingLifecycleNotificationsMock).toHaveBeenCalledWith({
      kind: "cancellation",
      bookingId: "bk-old",
    });
    expect(result.id).toBe("bk-old");
  });

  it("push-cancels the Google Calendar event after the DB cancellation commits (P2: unified booking lifecycle)", async () => {
    await cancelBookingAsOwner(ownerCtx(), "bk-old");
    expect(cancelBookingEventOnGoogleMock).toHaveBeenCalledWith({ eventId: "evt-old" });
  });

  it("never throws if the Google push-cancel itself fails - the DB cancellation has already committed", async () => {
    cancelBookingEventOnGoogleMock.mockRejectedValueOnce(new Error("network failure"));
    await expect(cancelBookingAsOwner(ownerCtx(), "bk-old")).resolves.toMatchObject({
      id: "bk-old",
    });
  });

  it("attributes the audit entry to the real owner, not a system actor (unlike the token path)", async () => {
    await cancelBookingAsOwner(ownerCtx(), "bk-old");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", orgId: "org-a" }),
      expect.objectContaining({ action: "booking.cancel" }),
    );
    // No actorType override - audit() defaults it to "user" when omitted,
    // unlike cancelBookingViaToken's explicit actorType: "system".
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ actorType: expect.anything() }),
    );
  });

  it("rejects a booking that does not belong to the caller's org (tenant isolation) before touching the transaction", async () => {
    tenantDbMock.mockReturnValue({ booking: { findFirst: vi.fn(async () => null) } });
    await expect(cancelBookingAsOwner(ownerCtx("org-b"), "bk-old")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(unscopedMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects when the booking is already canceled", async () => {
    txMock.booking.findUniqueOrThrow.mockResolvedValue(confirmedBooking({ status: "CANCELED" }));
    await expect(cancelBookingAsOwner(ownerCtx(), "bk-old")).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("rejects canceling a booking that already started", async () => {
    txMock.booking.findUniqueOrThrow.mockResolvedValue(
      confirmedBooking({ startsAt: new Date("2026-01-01T00:00:00Z") }),
    );
    await expect(cancelBookingAsOwner(ownerCtx(), "bk-old")).rejects.toMatchObject({
      code: "too_late",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a booking that has already been RESCHEDULED (superseded by a successor) - it is no longer the guest's active appointment", async () => {
    // Found during PR #92 adversarial review: without this, canceling an
    // already-rescheduled booking would flip its status back to CANCELED
    // and send the guest a misleading "your booking was canceled" email for
    // an appointment that is actually still live at its new time.
    txMock.booking.findUniqueOrThrow.mockResolvedValue(confirmedBooking({ status: "RESCHEDULED" }));
    await expect(cancelBookingAsOwner(ownerCtx(), "bk-old")).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
    expect(sendBookingLifecycleNotificationsMock).not.toHaveBeenCalled();
  });

  it("PR #92 adversarial review: loses the race to a concurrent canceler (updateMany claims zero rows) - rejects and does NOT re-apply any side effect", async () => {
    // Simulates the real-Postgres race this review found and fixed: another
    // transaction's guarded update already committed CANCELED/RESCHEDULED
    // between this call's initial findUniqueOrThrow read and its own
    // updateMany, so updateMany's WHERE clause matches zero rows.
    txMock.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cancelBookingAsOwner(ownerCtx(), "bk-old")).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(txMock.calendarEvent.update).not.toHaveBeenCalled();
    expect(txMock.reminder.updateMany).not.toHaveBeenCalled();
    expect(txMock.activity.create).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(sendBookingLifecycleNotificationsMock).not.toHaveBeenCalled();
  });
});

describe("BookingError typing", () => {
  it("exposes machine-readable codes", () => {
    const e = new BookingError("x", "slot_taken");
    expect(e.code).toBe("slot_taken");
    expect(e.name).toBe("BookingError");
  });
});
