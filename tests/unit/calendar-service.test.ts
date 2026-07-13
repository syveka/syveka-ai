import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, unscopedMock, auditMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  unscopedMock: {
    eventAttendee: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: unscopedMock,
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));

import { CalendarError, createEvent, findConflicts, listEvents } from "@/server/services/calendar";
import type { EventInput } from "@/lib/validators/calendar";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "a@test.fi", orgId, role: "MEMBER", locale: "fi" };
}

function baseInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    title: "Meeting",
    timezone: "Europe/Helsinki",
    startsAt: "2026-02-02T09:00:00.000Z",
    endsAt: "2026-02-02T10:00:00.000Z",
    allDay: false,
    attendees: [],
    ...overrides,
  } as EventInput;
}

type Db = {
  calendarEvent: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  contact: { findFirst: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  company: { findFirst: ReturnType<typeof vi.fn> };
  deal: { findFirst: ReturnType<typeof vi.fn> };
  organizationMember: { findFirst: ReturnType<typeof vi.fn> };
};

function makeDb(): Db {
  return {
    calendarEvent: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "evt-1", startsAt: new Date() })),
      findFirst: vi.fn(async () => null),
    },
    contact: { findFirst: vi.fn(async () => ({ id: "c-1" })), count: vi.fn(async () => 0) },
    company: { findFirst: vi.fn(async () => ({ id: "co-1" })) },
    deal: { findFirst: vi.fn(async () => ({ id: "d-1" })) },
    organizationMember: { findFirst: vi.fn(async () => ({ id: "m-1" })) },
  };
}

let db: Db;
beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  tenantDbMock.mockReturnValue(db);
});

describe("tenant isolation", () => {
  it("every service call scopes through tenantDb(orgId)", async () => {
    await listEvents(ctx("org-xyz"), {
      from: new Date("2026-02-01T00:00:00Z"),
      to: new Date("2026-03-01T00:00:00Z"),
    });
    expect(tenantDbMock).toHaveBeenCalledWith("org-xyz");
  });

  it("rejects cross-tenant contact links on create", async () => {
    db.contact.findFirst.mockResolvedValue(null); // not found inside this org
    await expect(
      createEvent(ctx(), baseInput({ contactId: "11111111-1111-4111-8111-111111111111" })),
    ).rejects.toMatchObject({ code: "invalid_relation" });
    expect(db.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant deal links on create", async () => {
    db.deal.findFirst.mockResolvedValue(null);
    await expect(
      createEvent(ctx(), baseInput({ dealId: "22222222-2222-4222-8222-222222222222" })),
    ).rejects.toMatchObject({ code: "invalid_relation" });
  });

  it("rejects owners who are not organization members", async () => {
    db.organizationMember.findFirst.mockResolvedValue(null);
    await expect(
      createEvent(ctx(), baseInput({ ownerId: "33333333-3333-4333-8333-333333333333" })),
    ).rejects.toMatchObject({ code: "invalid_owner" });
  });
});

describe("event validation", () => {
  it("rejects unknown timezones", async () => {
    await expect(createEvent(ctx(), baseInput({ timezone: "Mars/Base" }))).rejects.toMatchObject({
      code: "invalid_timezone",
    });
  });

  it("rejects invalid recurrence rules (recurring event validation)", async () => {
    await expect(
      createEvent(ctx(), baseInput({ recurrenceRule: "FREQ=YEARLY" })),
    ).rejects.toMatchObject({ code: "invalid_recurrence" });
    await expect(
      createEvent(ctx(), baseInput({ recurrenceRule: "FREQ=DAILY;COUNT=1;UNTIL=20270101" })),
    ).rejects.toBeInstanceOf(CalendarError);
  });

  it("creates events with defaults and audits", async () => {
    const event = await createEvent(ctx(), baseInput());
    expect(event.id).toBe("evt-1");
    const data = db.calendarEvent.create.mock.calls[0]![0].data;
    expect(data.ownerId).toBe("user-1"); // owner defaults to creator
    expect(data.source).toBe("MANUAL");
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "calendar.create" }),
    );
  });
});

describe("conflict detection", () => {
  it("finds overlapping plain events", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "busy-1",
        title: "Busy",
        startsAt: new Date("2026-02-02T09:30:00Z"),
        endsAt: new Date("2026-02-02T10:30:00Z"),
        recurrenceRule: null,
      },
    ]);
    const conflicts = await findConflicts(ctx(), {
      startsAt: new Date("2026-02-02T09:00:00Z"),
      endsAt: new Date("2026-02-02T10:00:00Z"),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.id).toBe("busy-1");
  });

  it("ignores non-overlapping and touching events", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "busy-1",
        title: "Before",
        startsAt: new Date("2026-02-02T08:00:00Z"),
        endsAt: new Date("2026-02-02T09:00:00Z"), // touches, no overlap
        recurrenceRule: null,
      },
    ]);
    const conflicts = await findConflicts(ctx(), {
      startsAt: new Date("2026-02-02T09:00:00Z"),
      endsAt: new Date("2026-02-02T10:00:00Z"),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("expands recurring series when checking conflicts", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "rec-1",
        title: "Weekly sync",
        startsAt: new Date("2026-01-05T09:00:00Z"), // Mondays
        endsAt: new Date("2026-01-05T10:00:00Z"),
        recurrenceRule: "FREQ=WEEKLY",
      },
    ]);
    const conflicts = await findConflicts(ctx(), {
      startsAt: new Date("2026-02-02T09:30:00Z"), // a later Monday
      endsAt: new Date("2026-02-02T10:30:00Z"),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.startsAt.toISOString()).toBe("2026-02-02T09:00:00.000Z");
  });
});

describe("recurring expansion in listEvents", () => {
  it("returns one row per occurrence inside the range", async () => {
    db.calendarEvent.findMany
      .mockResolvedValueOnce([]) // plain events
      .mockResolvedValueOnce([
        {
          id: "rec-1",
          title: "Daily standup",
          startsAt: new Date("2026-02-02T08:00:00Z"),
          endsAt: new Date("2026-02-02T08:15:00Z"),
          recurrenceRule: "FREQ=DAILY;COUNT=3",
          attendeeRecords: [],
          booking: null,
        },
      ]);
    const events = await listEvents(ctx(), {
      from: new Date("2026-02-01T00:00:00Z"),
      to: new Date("2026-02-10T00:00:00Z"),
    });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.isOccurrence)).toBe(true);
  });
});
