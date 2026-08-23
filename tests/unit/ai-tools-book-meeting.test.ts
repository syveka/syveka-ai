import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BookingServiceModule from "@/server/services/booking";

const {
  txMock,
  transactionMock,
  auditMock,
  tenantDbMock,
  serviceFindFirstMock,
  scheduleFindFirstMock,
  createVoiceBookingMock,
  sendNotificationsMock,
  scheduleRemindersMock,
  pushToGoogleMock,
  MockBookingError,
} = vi.hoisted(() => {
  const txMock = {
    $executeRaw: vi.fn(async () => 0),
    calendarEvent: { findFirst: vi.fn(), create: vi.fn() },
    contact: { findFirstOrThrow: vi.fn() },
  };
  /** Mirrors BookingError's real shape (code + message + instanceof-checkable). */
  class MockBookingError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    txMock,
    transactionMock: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    auditMock: vi.fn(async () => undefined),
    tenantDbMock: vi.fn(),
    serviceFindFirstMock: vi.fn(async () => null as { durationMinutes: number | null } | null),
    scheduleFindFirstMock: vi.fn(async () => null as unknown),
    createVoiceBookingMock: vi.fn(),
    sendNotificationsMock: vi.fn(async () => undefined),
    scheduleRemindersMock: vi.fn(async () => undefined),
    pushToGoogleMock: vi.fn(async () => "not_applicable" as const),
    MockBookingError,
  };
});

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: { $transaction: transactionMock },
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));
vi.mock("@/server/services/booking", async (importOriginal) => ({
  ...(await importOriginal<typeof BookingServiceModule>()),
  createVoiceBooking: createVoiceBookingMock,
  BookingError: MockBookingError,
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: sendNotificationsMock,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: scheduleRemindersMock }));
vi.mock("@/server/services/calendar-sync", () => ({ pushBookingEventToGoogle: pushToGoogleMock }));

import { TOOL_REGISTRY, type ToolIdentity } from "@/server/ai/tools";

const bookMeeting = TOOL_REGISTRY.find((t) => t.name === "bookMeeting")!;

function identity(overrides: Partial<ToolIdentity> = {}): ToolIdentity {
  return { orgId: "org-a", userId: "user-1", role: "MANAGER", actorType: "user", ...overrides };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    title: "Intro call",
    startsAt: "2026-08-17T10:00:00.000Z",
    durationMinutes: 30,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMock.calendarEvent.findFirst.mockResolvedValue(null); // no conflict
  txMock.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
  txMock.contact.findFirstOrThrow.mockResolvedValue({ id: "contact-1" });
  serviceFindFirstMock.mockResolvedValue(null);
  scheduleFindFirstMock.mockResolvedValue(null);
  tenantDbMock.mockReturnValue({
    businessDnaService: { findFirst: serviceFindFirstMock },
    availabilitySchedule: { findFirst: scheduleFindFirstMock },
  });
  pushToGoogleMock.mockResolvedValue("not_applicable");
});

describe("bookMeeting tool", () => {
  it("books a meeting when the shared org calendar has no conflict", async () => {
    const result = await bookMeeting.execute(identity(), input());
    expect(result).toMatchObject({ booked: true, eventId: "evt-1" });
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: "org-a", title: "Intro call" }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "calendar.book", resourceId: "evt-1" }),
    );
  });

  it("re-check guard: rejects when the in-transaction conflict query finds a row", async () => {
    // Proves the guard clause fires when the conflict query returns a row - not
    // concurrency safety itself, since a mocked single-threaded transaction can't
    // reproduce two real Postgres transactions racing under READ COMMITTED. See
    // the "serializes concurrent" test below for the lock-ordering regression
    // coverage, and tests/integration/ai-book-meeting-concurrency.sh for a
    // real-Postgres proof.
    txMock.calendarEvent.findFirst.mockResolvedValue({ id: "concurrent-evt" });
    const result = await bookMeeting.execute(identity(), input());
    expect(result).toEqual({ booked: false, reason: "slot_taken" });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent bookMeeting calls: acquires the org-calendar advisory lock before checking/writing, keyed on the trusted orgId", async () => {
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

    await bookMeeting.execute(identity({ orgId: "org-a" }), input());

    // Lock must be the *first* statement in the transaction, before the
    // conflict re-check and before any write - otherwise a second concurrent
    // transaction could race assertConflict's SELECT under READ COMMITTED.
    expect(callOrder).toEqual(["lock", "conflict-check", "create-event"]);
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
    // The lock's key is the caller's trusted identity.orgId, not anything from
    // the model-supplied tool input (which has no org/owner field at all).
    expect(txMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "org-a");
  });

  it("rejects a contactId that does not belong to the caller's organization", async () => {
    txMock.contact.findFirstOrThrow.mockRejectedValue(new Error("No Contact found"));
    await expect(
      bookMeeting.execute(identity(), input({ contactId: "22222222-2222-4222-8222-222222222222" })),
    ).rejects.toThrow();
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("links a contactId that does belong to the caller's organization", async () => {
    const result = await bookMeeting.execute(
      identity(),
      input({ contactId: "33333333-3333-4333-8333-333333333333" }),
    );
    expect(result).toMatchObject({ booked: true });
    expect(txMock.contact.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "33333333-3333-4333-8333-333333333333", organizationId: "org-a" },
    });
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactId: "33333333-3333-4333-8333-333333333333" }),
      }),
    );
  });

  describe("serviceName duration resolution (First Customer Readiness milestone)", () => {
    it("books using the named service's real duration instead of a caller-guessed default", async () => {
      serviceFindFirstMock.mockResolvedValueOnce({ durationMinutes: 45 });

      const result = await bookMeeting.execute(
        identity(),
        input({ durationMinutes: undefined, serviceName: "Haircut" }),
      );

      expect(result).toMatchObject({ booked: true });
      expect(serviceFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, name: { equals: "Haircut", mode: "insensitive" } },
        }),
      );
      const created = txMock.calendarEvent.create.mock.calls[0]![0].data;
      expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(45 * 60_000);
    });

    it("an explicit durationMinutes overrides service-name resolution", async () => {
      serviceFindFirstMock.mockResolvedValueOnce({ durationMinutes: 45 });
      await bookMeeting.execute(identity(), input({ durationMinutes: 15, serviceName: "Haircut" }));
      expect(serviceFindFirstMock).not.toHaveBeenCalled();
      const created = txMock.calendarEvent.create.mock.calls[0]![0].data;
      expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(15 * 60_000);
    });

    it("falls back to 30 minutes when neither durationMinutes nor a matching service is given", async () => {
      await bookMeeting.execute(identity(), input({ durationMinutes: undefined }));
      const created = txMock.calendarEvent.create.mock.calls[0]![0].data;
      expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(30 * 60_000);
    });
  });
});

describe("bookMeeting tool — voice_ai path (P2: unified booking lifecycle)", () => {
  function voiceIdentity(overrides: Partial<ToolIdentity> = {}): ToolIdentity {
    return {
      orgId: "org-a",
      userId: "owner-1",
      role: "MANAGER",
      actorType: "voice_ai",
      callerPhone: "+358401234567",
      assistantLanguage: "FI",
      ...overrides,
    };
  }

  function voiceBookingResult(overrides: Record<string, unknown> = {}) {
    return {
      booking: { id: "booking-1", startsAt: new Date("2026-08-17T10:00:00.000Z") },
      event: { id: "evt-1" },
      contactId: "contact-1",
      manageToken: "manage-token-1",
      bookingType: { id: "bt-1", name: "Haircut", ownerId: "owner-1", location: null },
      ...overrides,
    };
  }

  it("refuses to book without asking the model for guestName/guestEmail first - never guesses them", async () => {
    const result = await bookMeeting.execute(voiceIdentity(), input());
    expect(result).toMatchObject({ booked: false, reason: "missing_guest_details" });
    expect(createVoiceBookingMock).not.toHaveBeenCalled();
    expect(sendNotificationsMock).not.toHaveBeenCalled();
  });

  it("creates a real Booking (not a bare CalendarEvent) and fires confirmation, reminder, and Google push", async () => {
    createVoiceBookingMock.mockResolvedValue(voiceBookingResult());

    const result = await bookMeeting.execute(
      voiceIdentity(),
      input({ guestName: "Maria Virtanen", guestEmail: "maria@example.fi" }),
    );

    expect(result).toMatchObject({ booked: true, eventId: "evt-1", bookingId: "booking-1" });
    expect(createVoiceBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        actorUserId: "owner-1",
        guestName: "Maria Virtanen",
        guestEmail: "maria@example.fi",
        guestPhone: "+358401234567", // fell back to identity.callerPhone
        guestLocale: "FI", // from identity.assistantLanguage
        timezone: "Europe/Helsinki", // resolveOrgDefaultSchedule's fallback default
      }),
    );
    expect(sendNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "confirmation",
        bookingId: "booking-1",
        manageToken: "manage-token-1",
      }),
    );
    expect(scheduleRemindersMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", eventId: "evt-1" }),
    );
    expect(pushToGoogleMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", ownerId: "owner-1", eventId: "evt-1" }),
    );
    // createVoiceBooking already audits "booking.create" internally - no
    // second, duplicate audit call from bookMeeting itself for this path.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("an explicitly passed guestPhone wins over identity.callerPhone", async () => {
    createVoiceBookingMock.mockResolvedValue(voiceBookingResult());
    await bookMeeting.execute(
      voiceIdentity(),
      input({ guestName: "Maria", guestEmail: "maria@example.fi", guestPhone: "+358409999999" }),
    );
    expect(createVoiceBookingMock).toHaveBeenCalledWith(
      expect.objectContaining({ guestPhone: "+358409999999" }),
    );
  });

  it("surfaces a missing pilot-default BookingType as a loud, specific tool error - never silently guesses one", async () => {
    createVoiceBookingMock.mockRejectedValue(
      new MockBookingError(
        "No AI-default booking type configured",
        "ai_booking_type_not_configured",
      ),
    );

    const result = await bookMeeting.execute(
      voiceIdentity(),
      input({ guestName: "Maria", guestEmail: "maria@example.fi" }),
    );

    expect(result).toMatchObject({ booked: false, reason: "ai_booking_type_not_configured" });
    expect(sendNotificationsMock).not.toHaveBeenCalled();
    expect(scheduleRemindersMock).not.toHaveBeenCalled();
    expect(pushToGoogleMock).not.toHaveBeenCalled();
  });

  it("surfaces a slot_taken race from createVoiceBooking the same way", async () => {
    createVoiceBookingMock.mockRejectedValue(
      new MockBookingError("Slot no longer available", "slot_taken"),
    );
    const result = await bookMeeting.execute(
      voiceIdentity(),
      input({ guestName: "Maria", guestEmail: "maria@example.fi" }),
    );
    expect(result).toMatchObject({ booked: false, reason: "slot_taken" });
  });

  it("propagates a non-BookingError from createVoiceBooking (unexpected failure) rather than swallowing it", async () => {
    createVoiceBookingMock.mockRejectedValue(new Error("db unreachable"));
    await expect(
      bookMeeting.execute(
        voiceIdentity(),
        input({ guestName: "Maria", guestEmail: "maria@example.fi" }),
      ),
    ).rejects.toThrow("db unreachable");
  });

  it("does not need guestName/guestEmail for the in-app chat path (actorType 'user') - unchanged behavior", async () => {
    const result = await bookMeeting.execute(identity(), input());
    expect(result).toMatchObject({ booked: true, eventId: "evt-1" });
    expect(createVoiceBookingMock).not.toHaveBeenCalled();
  });
});
