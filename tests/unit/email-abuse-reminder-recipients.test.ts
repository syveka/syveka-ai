import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * reminderRecipientsToCharge: the addresses a calendar save sends new
 * reminder email to, which is what the reminder budget is spent by. Moving an
 * event schedules its reminders again, so a move charges every address; that
 * closed a way to resend reminders to 50 addresses for free. Read through the
 * organization's own scoped client.
 */
const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  tenantDb: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: m.tenantDb,
  unscopedPrisma: {},
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/services/booking", () => ({
  cancelBookingAsOwner: vi.fn(),
  BookingError: class BookingError extends Error {},
}));
vi.mock("@/server/services/reminders", () => ({ rescheduleEventReminders: vi.fn() }));

import { reminderRecipientsToCharge } from "@/server/services/calendar";

const ctx = { orgId: "org-a", userId: "user-1", role: "MEMBER", locale: "en" } as never;
const STARTS = "2026-11-20T10:00:00.000Z";
const stored = (emails: Array<string | null>, startsAt = STARTS) => ({
  startsAt: new Date(startsAt),
  attendeeRecords: emails.map((email) => ({ email })),
});

beforeEach(() => {
  vi.clearAllMocks();
  m.tenantDb.mockReturnValue({ calendarEvent: { findFirst: m.findFirst } });
});

describe("reminderRecipientsToCharge", () => {
  it("a new event charges every distinct address, ignoring case; rows without one charge nothing", async () => {
    const charged = await reminderRecipientsToCharge(ctx, undefined, {
      startsAt: STARTS,
      attendees: [
        { email: "Ann@Example.test" },
        { email: "ann@example.test" },
        { email: "bob@example.test" },
        { contactId: "11111111-1111-4111-8111-111111111111" },
      ],
    });
    expect(charged.sort()).toEqual(["ann@example.test", "bob@example.test"]);
    expect(m.findFirst).not.toHaveBeenCalled();
  });

  it("an edit at the same time charges only the addresses not already on the event", async () => {
    m.findFirst.mockResolvedValue(stored(["ANN@example.test", null]));
    const charged = await reminderRecipientsToCharge(ctx, "event-1", {
      startsAt: STARTS,
      attendees: [{ email: "ann@example.test" }, { email: "carol@example.test" }],
    });
    expect(charged).toEqual(["carol@example.test"]);
  });

  it("an edit that moves the event charges every address: its reminders are sent again", async () => {
    m.findFirst.mockResolvedValue(stored(["ann@example.test", "bob@example.test"]));
    const charged = await reminderRecipientsToCharge(ctx, "event-1", {
      startsAt: "2026-11-20T10:01:00.000Z",
      attendees: [{ email: "ann@example.test" }, { email: "bob@example.test" }],
    });
    expect(charged.sort()).toEqual(["ann@example.test", "bob@example.test"]);
  });

  it("the same instant in another notation is not a move", async () => {
    m.findFirst.mockResolvedValue(stored(["ann@example.test"]));
    const charged = await reminderRecipientsToCharge(ctx, "event-1", {
      startsAt: "2026-11-20T12:00:00+02:00",
      attendees: [{ email: "ann@example.test" }],
    });
    expect(charged).toEqual([]);
  });

  it("reads through the organization's scoped client, by id and not deleted", async () => {
    m.findFirst.mockResolvedValue(null);
    await reminderRecipientsToCharge(ctx, "event-1", {
      startsAt: STARTS,
      attendees: [{ email: "x@example.test" }],
    });
    expect(m.tenantDb).toHaveBeenCalledWith("org-a");
    expect(m.findFirst).toHaveBeenCalledWith({
      where: { id: "event-1", deletedAt: null },
      select: { startsAt: true, attendeeRecords: { select: { email: true } } },
    });
  });

  it("an event the organization can't see charges every submitted address", async () => {
    m.findFirst.mockResolvedValue(null);
    const charged = await reminderRecipientsToCharge(ctx, "someone-elses-event", {
      startsAt: STARTS,
      attendees: [{ email: "x@example.test" }],
    });
    expect(charged).toEqual(["x@example.test"]);
  });

  it("no address submitted: nothing to read, nothing charged", async () => {
    expect(
      await reminderRecipientsToCharge(ctx, "event-1", { startsAt: STARTS, attendees: [] }),
    ).toEqual([]);
    expect(m.findFirst).not.toHaveBeenCalled();
  });
});
