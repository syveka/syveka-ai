import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * addedAttendeeEmails: the addresses a calendar save adds, which is what the
 * reminder budget is spent by. Read through the organization's own scoped
 * client, so another organization's event adds nothing it can see.
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

import { addedAttendeeEmails } from "@/server/services/calendar";

const ctx = { orgId: "org-a", userId: "user-1", role: "MEMBER", locale: "en" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.tenantDb.mockReturnValue({ calendarEvent: { findFirst: m.findFirst } });
});

describe("addedAttendeeEmails", () => {
  it("a new event adds every distinct address, ignoring case; rows without one add nothing", async () => {
    const added = await addedAttendeeEmails(ctx, undefined, [
      { email: "Ann@Example.test" },
      { email: "ann@example.test" },
      { email: "bob@example.test" },
      { contactId: "11111111-1111-4111-8111-111111111111" },
    ]);
    expect(added.sort()).toEqual(["ann@example.test", "bob@example.test"]);
    expect(m.findFirst).not.toHaveBeenCalled();
  });

  it("an edit adds only the addresses not already on the event", async () => {
    m.findFirst.mockResolvedValue({
      attendeeRecords: [{ email: "ANN@example.test" }, { email: null }],
    });
    const added = await addedAttendeeEmails(ctx, "event-1", [
      { email: "ann@example.test" },
      { email: "carol@example.test" },
    ]);
    expect(added).toEqual(["carol@example.test"]);
  });

  it("reads through the organization's scoped client, by id and not deleted", async () => {
    m.findFirst.mockResolvedValue(null);
    await addedAttendeeEmails(ctx, "event-1", [{ email: "x@example.test" }]);
    expect(m.tenantDb).toHaveBeenCalledWith("org-a");
    expect(m.findFirst).toHaveBeenCalledWith({
      where: { id: "event-1", deletedAt: null },
      select: { attendeeRecords: { select: { email: true } } },
    });
  });

  it("an event the organization can't see counts every submitted address", async () => {
    m.findFirst.mockResolvedValue(null);
    const added = await addedAttendeeEmails(ctx, "someone-elses-event", [
      { email: "x@example.test" },
    ]);
    expect(added).toEqual(["x@example.test"]);
  });

  it("no address submitted: nothing to read, nothing added", async () => {
    expect(await addedAttendeeEmails(ctx, "event-1", [])).toEqual([]);
    expect(m.findFirst).not.toHaveBeenCalled();
  });
});
