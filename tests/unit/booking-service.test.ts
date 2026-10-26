import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBookingInput } from "@/lib/validators/booking";
import { findFirstOver, findManyOver, findManyPagedOver } from "./helpers/calendar-event-where";

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
} = vi.hoisted(() => {
  const txMock = {
    $executeRaw: vi.fn(async () => 0),
    // Eligibility locks (owner membership, then the booking type): granted here;
    // removal and ineligible owners are covered in booking-owner-removal.test.ts.
    $queryRaw: vi.fn(async () => [{ role: "OWNER", id: "bt-1" }]),
    calendarEvent: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    contact: { findFirst: vi.fn(), create: vi.fn() },
    eventAttendee: { create: vi.fn(), findFirst: vi.fn() },
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
      // The booking type's owner is a current member.
      organizationMember: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
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

import {
  BookingError,
  cancelBookingAsOwner,
  cancelBookingViaToken,
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
  txMock.calendarEvent.findMany.mockResolvedValue([]); // no recurring series inside tx
  txMock.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
  txMock.contact.findFirst.mockResolvedValue(null);
  txMock.contact.create.mockResolvedValue({ id: "contact-new" });
  txMock.eventAttendee.create.mockResolvedValue({});
  txMock.eventAttendee.findFirst.mockResolvedValue(null);
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
    // The guest's contact is linked through the attendee row only (CRM
    // Meetings finds it there); the event itself carries no duplicate link.
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ contactId: expect.anything() }),
    });
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: expect.any(String) }),
    });
    // The guest's manage link stays valid at least until the meeting ends.
    expect(issueTokenMock).toHaveBeenCalledWith("bk-1", "MANAGE", undefined, result.booking.endsAt);
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

  it("passes the guest's contact to booking.created workflows, so their CRM steps have a target", async () => {
    txMock.contact.findFirst.mockResolvedValue({ id: "contact-9" });
    await createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() });
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.created",
      expect.objectContaining({ bookingId: "bk-1", contactId: "contact-9" }),
      "bk-1",
    );
  });

  it("booking.created carries exactly the booking, contact, type, guest and time, keyed by the booking id", async () => {
    txMock.contact.findFirst.mockResolvedValue({ id: "contact-9" });
    await createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.created",
      {
        bookingId: "bk-1",
        contactId: "contact-9",
        bookingType: "Intro call",
        guestName: "Guest One",
        guestEmail: "guest@example.com",
        startsAt: VALID_START,
      },
      "bk-1",
    );
  });

  it("a brand-new guest's booking.created carries the contact this booking just created", async () => {
    await createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() });
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.created",
      expect.objectContaining({ contactId: "contact-new" }),
      "bk-1",
    );
  });

  describe("contact.created workflow event", () => {
    const contactCreatedCalls = () =>
      (emitMock.mock.calls as unknown as unknown[][]).filter(
        (args) => args[1] === "contact.created",
      );

    it("a brand-new guest's contact emits contact.created once, after the booking transaction commits", async () => {
      txMock.contact.findFirst.mockResolvedValue(null);
      txMock.contact.create.mockResolvedValue({
        id: "contact-new",
        firstName: "Jane",
        lastName: "Customer",
        email: "guest@example.com",
        phone: "+358401234567",
        source: "public-booking",
      });
      let committed = false;
      unscopedMock.$transaction.mockImplementationOnce(
        async (fn: (tx: typeof txMock) => Promise<unknown>) => {
          const result = await fn(txMock);
          committed = true;
          return result;
        },
      );
      emitMock.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "contact.created") expect(committed).toBe(true);
      });

      await createPublicBooking({
        orgSlug: "acme",
        typeSlug: "intro-call",
        input: input({ name: "Jane Customer", phone: "+358401234567" }),
      });

      expect(contactCreatedCalls()).toEqual([
        [
          "org-a",
          "contact.created",
          {
            contactId: "contact-new",
            firstName: "Jane",
            lastName: "Customer",
            email: "guest@example.com",
            phone: "+358401234567",
            source: "public-booking",
          },
          "contact-new",
        ],
      ]);
      emitMock.mockImplementation(async () => undefined);
    });

    it("a guest matched to an existing contact emits no contact.created", async () => {
      txMock.contact.findFirst.mockResolvedValue({ id: "contact-9" });
      await createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() });
      expect(contactCreatedCalls()).toEqual([]);
      expect(emitMock).toHaveBeenCalledWith(
        "org-a",
        "booking.created",
        expect.anything(),
        expect.anything(),
      );
    });

    it("a failing workflow queue still completes the booking with its new contact", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      txMock.contact.findFirst.mockResolvedValue(null);
      emitMock.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "contact.created") throw new Error("queue unavailable");
      });

      const result = await createPublicBooking({
        orgSlug: "acme",
        typeSlug: "intro-call",
        input: input(),
      });

      expect(result.booking).toBeDefined();
      expect(result.contactId).toBe("contact-new");
      expect(result).not.toHaveProperty("newContact");
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).toContain("contact_created_workflow_event_failed");
      expect(logged).not.toContain("guest@example.com");
      emitMock.mockImplementation(async () => undefined);
      errorSpy.mockRestore();
    });
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

  it("the moved meeting keeps the guest's CRM contact on its attendee (CRM Meetings)", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await rescheduleBookingViaToken("raw-token", NEW_START);

    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledWith({
      where: { eventId: "evt-old", email: "guest@example.com" },
      select: { contactId: true },
    });
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: "contact-guest", email: "guest@example.com" }),
    });
    // The relationship stays on the attendee only, as for new bookings.
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ contactId: expect.anything() }),
    });
  });

  it("a guest attendee without a contact stays without one", async () => {
    await rescheduleBookingViaToken("raw-token", NEW_START);
    expect(txMock.eventAttendee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: null }),
    });
  });

  // #339: the "Booking rescheduled" timeline entry used to be stored with
  // contact_id = null, so it never showed on the guest's contact page.
  it("the reschedule activity is linked to the guest's CRM contact, in the booking's own org", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await rescheduleBookingViaToken("raw-token", NEW_START);

    expect(txMock.activity.create).toHaveBeenCalledTimes(1);
    expect(txMock.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-a",
        contactId: "contact-guest",
        type: "MEETING",
        subject: "Booking rescheduled: Intro call",
        metadata: { bookingId: "bk-1", previousBookingId: "bk-old", kind: "rescheduled" },
      }),
    });
    // The contact comes only from the old booking's own attendee row, so a
    // contact of another organization can never be attached.
    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledTimes(1);
    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "evt-old", email: "guest@example.com" } }),
    );
  });

  it("the reschedule activity has a null contact when the guest has none (unchanged behavior)", async () => {
    await rescheduleBookingViaToken("raw-token", NEW_START);
    expect(txMock.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contactId: null,
        subject: "Booking rescheduled: Intro call",
      }),
    });
  });

  it("booking.rescheduled carries the contact, guest, type, and both times, keyed by the successor booking", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await rescheduleBookingViaToken("raw-token", NEW_START);

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.rescheduled",
      {
        bookingId: "bk-1",
        previousBookingId: "bk-old",
        contactId: "contact-guest",
        bookingType: "Intro call",
        guestName: "Guest One",
        guestEmail: "guest@example.com",
        startsAt: NEW_START,
        previousStartsAt: VALID_START,
      },
      // The successor's own id: each reschedule is a distinct event, and a
      // retry of the same one is deduplicated (sourceEventKey).
      "bk-1",
    );
  });

  it("booking.rescheduled has a null contactId when the guest has no contact", async () => {
    await rescheduleBookingViaToken("raw-token", NEW_START);
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.rescheduled",
      expect.objectContaining({ contactId: null }),
      "bk-1",
    );
  });

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

    const rescheduled = await rescheduleBookingViaToken("raw-token", NEW_START);

    expect(callOrder).toEqual(["consume-token", "re-fetch-status", "lock", "cancel-old-booking"]);
    // The new link also lives until the moved meeting ends.
    expect(issueTokenMock).toHaveBeenLastCalledWith(
      rescheduled.booking.id,
      "MANAGE",
      undefined,
      rescheduled.booking.endsAt,
    );
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

  it("booking.canceled carries the contact, guest, type, time and reason, keyed by the booking id", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await cancelBookingViaToken("raw-token", "change of plans");

    // The contact is looked up only through this booking's own event, within
    // the booking's organization.
    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledWith({
      where: { eventId: "evt-old", email: "guest@example.com", event: { organizationId: "org-a" } },
      select: { contactId: true },
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.canceled",
      {
        bookingId: "bk-old",
        contactId: "contact-guest",
        bookingType: "Intro call",
        guestName: "Guest One",
        guestEmail: "guest@example.com",
        startsAt: VALID_START,
        reason: "change of plans",
      },
      "bk-old",
    );
  });

  it("booking.canceled has a null contactId and reason when neither exists", async () => {
    await cancelBookingViaToken("raw-token");
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.canceled",
      expect.objectContaining({ contactId: null, reason: null }),
      "bk-old",
    );
  });

  it("a booking without a calendar event looks up no contact", async () => {
    txMock.booking.findUniqueOrThrow.mockResolvedValue(confirmedBooking({ eventId: null }));
    await cancelBookingViaToken("raw-token");
    expect(txMock.eventAttendee.findFirst).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.canceled",
      expect.objectContaining({ contactId: null }),
      "bk-old",
    );
    expect(txMock.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: null, subject: "Booking canceled: Intro call" }),
    });
  });

  // #339: the "Booking canceled" timeline entry used to be stored with
  // contact_id = null, so it never showed on the guest's contact page.
  it("the cancel activity is linked to the guest's CRM contact, looked up within the booking's org", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await cancelBookingViaToken("raw-token", "change of plans");

    expect(txMock.activity.create).toHaveBeenCalledTimes(1);
    expect(txMock.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-a",
        contactId: "contact-guest",
        type: "MEETING",
        subject: "Booking canceled: Intro call",
        body: "Guest One canceled. Reason: change of plans",
        metadata: { bookingId: "bk-old", kind: "canceled" },
      }),
    });
    // One tenant-bound lookup serves both the activity and the workflow payload.
    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledTimes(1);
    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledWith({
      where: { eventId: "evt-old", email: "guest@example.com", event: { organizationId: "org-a" } },
      select: { contactId: true },
    });
  });

  it("a guest attendee of another org's event is never linked (the tenant-scoped lookup finds nothing)", async () => {
    // The scoped query returns no row for a foreign-org attendee; the entry
    // then stays unlinked rather than pointing at a contact across tenants.
    txMock.eventAttendee.findFirst.mockResolvedValueOnce(null);
    await cancelBookingViaToken("raw-token");
    expect(txMock.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", contactId: null }),
    });
  });

  it("emits nothing when the cancel loses the race (no duplicate booking.canceled)", async () => {
    txMock.booking.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cancelBookingViaToken("raw-token")).rejects.toMatchObject({
      code: "already_canceled",
    });
    expect(emitMock).not.toHaveBeenCalled();
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

  it("booking.canceled from the owner carries the same payload as the guest path", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await cancelBookingAsOwner(ownerCtx(), "bk-old", "owner canceled by phone");

    expect(txMock.eventAttendee.findFirst).toHaveBeenCalledWith({
      where: { eventId: "evt-old", email: "guest@example.com", event: { organizationId: "org-a" } },
      select: { contactId: true },
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.canceled",
      {
        bookingId: "bk-old",
        contactId: "contact-guest",
        bookingType: "Intro call",
        guestName: "Guest One",
        guestEmail: "guest@example.com",
        startsAt: VALID_START,
        reason: "owner canceled by phone",
      },
      "bk-old",
    );
  });

  it("the owner-cancel activity is linked to the guest's CRM contact like the guest path (#339)", async () => {
    txMock.eventAttendee.findFirst.mockResolvedValueOnce({ contactId: "contact-guest" });

    await cancelBookingAsOwner(ownerCtx(), "bk-old", "owner canceled by phone");

    expect(txMock.activity.create).toHaveBeenCalledTimes(1);
    expect(txMock.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-a",
        contactId: "contact-guest",
        subject: "Booking canceled: Intro call",
        metadata: { bookingId: "bk-old", kind: "canceled" },
      }),
    });
  });

  it("an owner cancel from the calendar (no reason given) sends reason null", async () => {
    await cancelBookingAsOwner(ownerCtx(), "bk-old");
    expect(emitMock).toHaveBeenCalledWith(
      "org-a",
      "booking.canceled",
      expect.objectContaining({ reason: null }),
      "bk-old",
    );
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

/**
 * A recurring calendar series is stored once, as its first occurrence. Busy
 * checks must expand it: a weekly meeting that started last week still makes
 * this week's occurrence busy. The calendar mocks below filter the stored
 * rows by each query's real `where`, as the database would.
 */
describe("recurring calendar events", () => {
  // The owner's weekly Monday 09:00-10:00 Helsinki meeting, first held a week
  // before VALID_START (Mon 2026-02-02 09:00 Helsinki = 07:00Z).
  function weeklySeries(overrides: Record<string, unknown> = {}) {
    return {
      id: "evt-weekly",
      organizationId: "org-a",
      ownerId: "owner-1",
      createdById: "owner-1",
      deletedAt: null,
      status: "CONFIRMED",
      startsAt: new Date("2026-01-26T07:00:00Z"),
      endsAt: new Date("2026-01-26T08:00:00Z"),
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      ...overrides,
    };
  }

  function storeEvents(rows: Array<Record<string, unknown>>) {
    unscopedMock.calendarEvent.findMany.mockImplementation(findManyOver(rows) as never);
    txMock.calendarEvent.findMany.mockImplementation(findManyOver(rows) as never);
    txMock.calendarEvent.findFirst.mockImplementation(findFirstOver(rows) as never);
  }

  it("public slots leave out an occurrence of an earlier-started weekly series", async () => {
    storeEvents([weeklySeries()]);

    const { slots } = await getPublicSlots({
      orgSlug: "acme",
      typeSlug: "intro-call",
      from: new Date("2026-02-02T00:00:00Z"),
      to: new Date("2026-02-03T00:00:00Z"),
    });

    const offered = slots.map((s) => s.toISOString());
    expect(offered).not.toContain(VALID_START);
    expect(offered).toContain("2026-02-02T08:00:00.000Z"); // right after it: free
  });

  it("a series started in summer still blocks its local time in winter (DST)", async () => {
    // Monday 09:00 Helsinki since October 2025 (06:00Z in EEST); VALID_START is
    // Monday 09:00 Helsinki in February (07:00Z in EET).
    storeEvents([
      weeklySeries({
        startsAt: new Date("2025-10-13T06:00:00Z"),
        endsAt: new Date("2025-10-13T07:00:00Z"),
        timezone: "Europe/Helsinki",
      }),
    ]);

    const { slots } = await getPublicSlots({
      orgSlug: "acme",
      typeSlug: "intro-call",
      from: new Date("2026-02-02T00:00:00Z"),
      to: new Date("2026-02-03T00:00:00Z"),
    });
    expect(slots.map((s) => s.toISOString())).not.toContain(VALID_START);
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "invalid_slot" });

    unscopedMock.calendarEvent.findMany.mockResolvedValue([]); // isolate the in-transaction check
    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "slot_taken" });

    for (const findMany of [unscopedMock.calendarEvent.findMany, txMock.calendarEvent.findMany]) {
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ timezone: true }) }),
      );
    }
  });

  describe("more busy-time rows than one query returns", () => {
    // 1,500 newer series that ended long ago (COUNT=1 in 2025) plus the
    // owner's weekly Monday 09:00 series since 2014. Ordered newest first, a
    // single capped query never reaches the 2014 series.
    function crowdedOwner() {
      const ended = Array.from({ length: 1500 }, (_, i) =>
        weeklySeries({
          id: `ended-${String(i).padStart(4, "0")}`,
          startsAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000),
          endsAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000 + 1_800_000),
          recurrenceRule: "FREQ=WEEKLY;COUNT=1",
        }),
      );
      const old = weeklySeries({
        id: "old-weekly",
        startsAt: new Date("2014-01-06T07:00:00Z"),
        endsAt: new Date("2014-01-06T08:00:00Z"),
        timezone: "Europe/Helsinki",
      });
      const rows = [...ended, old];
      unscopedMock.calendarEvent.findMany.mockImplementation(findManyPagedOver(rows) as never);
      txMock.calendarEvent.findMany.mockImplementation(findManyPagedOver(rows) as never);
      txMock.calendarEvent.findFirst.mockImplementation(findFirstOver(rows) as never);
    }

    it("public slots don't offer the old series' time", async () => {
      crowdedOwner();
      const { slots } = await getPublicSlots({
        orgSlug: "acme",
        typeSlug: "intro-call",
        from: new Date("2026-02-02T00:00:00Z"),
        to: new Date("2026-02-03T00:00:00Z"),
      });
      expect(slots.map((s) => s.toISOString())).not.toContain(VALID_START);
      expect(slots.map((s) => s.toISOString())).toContain("2026-02-02T08:00:00.000Z");
    });

    it("no slot is offered when the busy rows can't all be read", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      unscopedMock.calendarEvent.findMany.mockImplementation((async (args: { take: number }) =>
        Array.from({ length: args.take }, (_, i) =>
          weeklySeries({ id: `row-${i}`, recurrenceRule: "FREQ=WEEKLY;COUNT=1" }),
        )) as never);
      const { slots } = await getPublicSlots({
        orgSlug: "acme",
        typeSlug: "intro-call",
        from: new Date("2026-02-02T00:00:00Z"),
        to: new Date("2026-02-03T00:00:00Z"),
      });
      expect(slots).toEqual([]);
      warn.mockRestore();
    });

    it("the in-transaction re-check refuses the old series' time", async () => {
      crowdedOwner();
      unscopedMock.calendarEvent.findMany.mockResolvedValue([]); // slots computed before
      await expect(
        createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
      ).rejects.toMatchObject({ code: "slot_taken" });
      expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
    });
  });

  it("a series running since 2014 (over 500 weeks) still blocks its slot", async () => {
    // Monday 09:00 Helsinki since Jan 2014. Expansion used to stop 500 steps
    // after the origin, so the slot showed as free.
    for (const timezone of ["Europe/Helsinki", null]) {
      storeEvents([
        weeklySeries({
          startsAt: new Date("2014-01-06T07:00:00Z"),
          endsAt: new Date("2014-01-06T08:00:00Z"),
          timezone,
        }),
      ]);
      const { slots } = await getPublicSlots({
        orgSlug: "acme",
        typeSlug: "intro-call",
        from: new Date("2026-02-02T00:00:00Z"),
        to: new Date("2026-02-03T00:00:00Z"),
      });
      expect(slots.map((s) => s.toISOString())).not.toContain(VALID_START);
      await expect(
        createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
      ).rejects.toMatchObject({ code: "invalid_slot" });
    }
  });

  it("a guest can't book a series occurrence", async () => {
    storeEvents([weeklySeries()]);

    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "invalid_slot" });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("the in-transaction re-check catches a series created after the slots were shown", async () => {
    storeEvents([weeklySeries()]);
    unscopedMock.calendarEvent.findMany.mockResolvedValue([]); // slots computed before it existed

    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("an ended, canceled, deleted or other owner's series doesn't block the slot", async () => {
    storeEvents([
      weeklySeries({ id: "ended", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO;COUNT=1" }),
      weeklySeries({ id: "canceled", status: "CANCELED" }),
      weeklySeries({ id: "deleted", deletedAt: new Date("2026-01-27T00:00:00Z") }),
      weeklySeries({ id: "other-owner", ownerId: "someone-else", createdById: "someone-else" }),
    ]);

    const result = await createPublicBooking({
      orgSlug: "acme",
      typeSlug: "intro-call",
      input: input(),
    });

    expect(result.booking.startsAt.toISOString()).toBe(VALID_START);
  });

  it("an unparseable stored rule still blocks its first occurrence (as the calendar treats it)", async () => {
    storeEvents([
      weeklySeries({
        startsAt: new Date(VALID_START),
        endsAt: new Date("2026-02-02T08:00:00Z"),
        recurrenceRule: "FREQ=YEARLY",
      }),
    ]);

    await expect(
      createPublicBooking({ orgSlug: "acme", typeSlug: "intro-call", input: input() }),
    ).rejects.toMatchObject({ code: "invalid_slot" });
  });

  it("a guest can't reschedule onto a series occurrence", async () => {
    const old = {
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
      startsAt: new Date("2026-02-03T08:00:00Z"),
      endsAt: new Date("2026-02-03T09:00:00Z"),
    };
    resolveTokenMock.mockResolvedValue({ id: "token-1", purpose: "RESCHEDULE", booking: old });
    txMock.booking.findUniqueOrThrow.mockResolvedValue(old);
    storeEvents([weeklySeries()]);
    unscopedMock.calendarEvent.findMany.mockResolvedValue([]); // isolate the in-transaction check

    await expect(rescheduleBookingViaToken("raw-token", VALID_START)).rejects.toMatchObject({
      code: "slot_taken",
    });
    expect(txMock.booking.updateMany).not.toHaveBeenCalled();
  });
});
