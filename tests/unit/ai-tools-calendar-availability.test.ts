import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tenantDbMock, scheduleFindFirstMock, eventFindManyMock, serviceFindFirstMock, auditMock } =
  vi.hoisted(() => ({
    tenantDbMock: vi.fn(),
    scheduleFindFirstMock: vi.fn(),
    eventFindManyMock: vi.fn(async () => [] as { startsAt: Date; endsAt: Date }[]),
    serviceFindFirstMock: vi.fn(async () => null as { durationMinutes: number | null } | null),
    auditMock: vi.fn(async () => undefined),
  }));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));

import { TOOL_REGISTRY, type ToolIdentity } from "@/server/ai/tools";
import { findManyOver, findManyPagedOver } from "./helpers/calendar-event-where";

const getCalendarAvailability = TOOL_REGISTRY.find((t) => t.name === "getCalendarAvailability")!;

function identity(orgId = "org-a"): ToolIdentity {
  return { orgId, userId: "user-1", role: "MEMBER", actorType: "user" };
}

describe("getCalendarAvailability tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The tool computes slots against the real system clock (`now: new Date()` in
    // src/server/ai/tools/index.ts, correctly clamping out already-passed slots on
    // "today"). Every scenario below targets 2026-08-17 (a Monday), so freeze "now"
    // to the day before - safely earlier than that day's 00:00 Europe/Helsinki
    // (2026-08-16T21:00:00Z) - or the clamp would start eating into the expected
    // slots the instant a real run's wall-clock time reaches 2026-08-17, exactly as
    // happened here. Matches the frozen-clock convention already used in
    // tests/unit/booking-service.test.ts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T10:00:00.000Z"));
    tenantDbMock.mockReturnValue({
      availabilitySchedule: { findFirst: scheduleFindFirstMock },
      calendarEvent: { findMany: eventFindManyMock },
      businessDnaService: { findFirst: serviceFindFirstMock },
    });
    scheduleFindFirstMock.mockResolvedValue(null);
    eventFindManyMock.mockResolvedValue([]);
    serviceFindFirstMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to the generic Mon-Fri 09:00-17:00 default and flags it when the org has no schedule configured", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce(null);

    // A Monday.
    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { usingOrgConfiguredHours: boolean; freeSlots: string[]; timezone: string };

    expect(result.usingOrgConfiguredHours).toBe(false);
    expect(result.timezone).toBe("Europe/Helsinki");
    expect(result.freeSlots.length).toBeGreaterThan(0);
    // First slot should be 09:00 local (06:00 UTC in August, EEST = UTC+3).
    expect(result.freeSlots[0]).toBe("2026-08-17T06:00:00.000Z");
  });

  it("uses the organization's real configured schedule instead of the generic default", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce({
      timezone: "Europe/Helsinki",
      rules: [{ weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60 }], // Monday 10:00-12:00 only
      overrides: [],
    });

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17", // Monday
    })) as { usingOrgConfiguredHours: boolean; freeSlots: string[] };

    expect(result.usingOrgConfiguredHours).toBe(true);
    // Real schedule only opens 10:00-12:00 -> first slot is 10:00 EEST = 07:00 UTC, not 09:00.
    expect(result.freeSlots[0]).toBe("2026-08-17T07:00:00.000Z");
    expect(result.freeSlots.every((s) => s < "2026-08-17T09:00:00.000Z")).toBe(true);
  });

  it("rejects the invalid schedule timezone rather than silently using it, falling back to Europe/Helsinki", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce({
      timezone: "Not/ARealZone",
      rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
      overrides: [],
    });

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { timezone: string };

    expect(result.timezone).toBe("Europe/Helsinki");
  });

  it("excludes slots that overlap an existing calendar event", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce(null); // default Mon-Fri 09-17
    eventFindManyMock.mockResolvedValueOnce([
      {
        startsAt: new Date("2026-08-17T06:00:00.000Z"),
        endsAt: new Date("2026-08-17T06:30:00.000Z"),
      },
    ]);

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { freeSlots: string[] };

    expect(result.freeSlots).not.toContain("2026-08-17T06:00:00.000Z");
    expect(result.freeSlots).toContain("2026-08-17T06:30:00.000Z");
  });

  it("excludes an occurrence of a weekly series that started on an earlier week", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce(null); // default Mon-Fri 09-17
    // Monday 09:00-09:30 Helsinki every week, first held a week earlier. The
    // mock filters by the query's real `where`, as the database would.
    eventFindManyMock.mockImplementation(
      findManyOver([
        {
          deletedAt: null,
          status: "CONFIRMED",
          startsAt: new Date("2026-08-10T06:00:00.000Z"),
          endsAt: new Date("2026-08-10T06:30:00.000Z"),
          recurrenceRule: "FREQ=WEEKLY",
        },
      ]) as never,
    );

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { freeSlots: string[] };

    expect(result.freeSlots).not.toContain("2026-08-17T06:00:00.000Z");
    expect(result.freeSlots).toContain("2026-08-17T06:30:00.000Z");
  });

  it("a series started in winter is busy at its local time in summer (DST)", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce(null); // default Mon-Fri 09-17
    // Monday 09:00-09:30 Helsinki from March (07:00Z in EET); in August 09:00 is 06:00Z.
    eventFindManyMock.mockImplementation(
      findManyOver([
        {
          deletedAt: null,
          status: "CONFIRMED",
          startsAt: new Date("2026-03-16T07:00:00.000Z"),
          endsAt: new Date("2026-03-16T07:30:00.000Z"),
          recurrenceRule: "FREQ=WEEKLY",
          timezone: "Europe/Helsinki",
        },
      ]) as never,
    );

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { freeSlots: string[] };

    expect(result.freeSlots).not.toContain("2026-08-17T06:00:00.000Z");
    expect(result.freeSlots).toContain("2026-08-17T07:00:00.000Z");
    expect(eventFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ timezone: true }) }),
    );
  });

  it("an old series stays busy when the org has more rows than one query returns", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce(null); // default Mon-Fri 09-17
    // 1,500 newer series that ended in 2025, plus Monday 09:00 Helsinki since 2014.
    const ended = Array.from({ length: 1500 }, (_, i) => ({
      id: `ended-${String(i).padStart(4, "0")}`,
      deletedAt: null,
      status: "CONFIRMED",
      startsAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000),
      endsAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000 + 1_800_000),
      recurrenceRule: "FREQ=WEEKLY;COUNT=1",
      timezone: "Europe/Helsinki",
    }));
    eventFindManyMock.mockImplementation(
      findManyPagedOver([
        ...ended,
        {
          id: "old-weekly",
          deletedAt: null,
          status: "CONFIRMED",
          startsAt: new Date("2014-01-06T07:00:00.000Z"),
          endsAt: new Date("2014-01-06T07:30:00.000Z"),
          recurrenceRule: "FREQ=WEEKLY",
          timezone: "Europe/Helsinki",
        },
      ]) as never,
    );

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { freeSlots: string[] };

    expect(result.freeSlots).not.toContain("2026-08-17T06:00:00.000Z"); // 09:00 EEST
    expect(result.freeSlots).toContain("2026-08-17T06:30:00.000Z");
  });

  it("offers no slot when the busy rows can't all be read", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Every page comes back full: the loader stops at its page limit.
    eventFindManyMock.mockImplementation((async (args: { take: number }) =>
      Array.from({ length: args.take }, (_, i) => ({
        id: `row-${i}`,
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-01-01T00:30:00.000Z"),
        recurrenceRule: null,
        timezone: "UTC",
      }))) as never);

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { freeSlots: string[] };

    expect(result.freeSlots).toEqual([]);
    warn.mockRestore();
  });

  it("applies a date override marking the day fully unavailable", async () => {
    scheduleFindFirstMock.mockResolvedValueOnce({
      timezone: "Europe/Helsinki",
      rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
      overrides: [
        {
          date: new Date("2026-08-17T00:00:00.000Z"),
          startMinute: null,
          endMinute: null,
          isUnavailable: true,
        },
      ],
    });

    const result = (await getCalendarAvailability.execute(identity(), {
      date: "2026-08-17",
    })) as { freeSlots: string[] };

    expect(result.freeSlots).toEqual([]);
  });

  it("scopes both the schedule lookup and the busy-event lookup to the caller's org (tenant isolation)", async () => {
    await getCalendarAvailability.execute(identity("org-b"), { date: "2026-08-17" });
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
  });

  describe("serviceName duration resolution (First Customer Readiness milestone)", () => {
    it("uses the named service's real duration instead of the 30-minute default", async () => {
      serviceFindFirstMock.mockResolvedValueOnce({ durationMinutes: 45 });

      const result = (await getCalendarAvailability.execute(identity(), {
        date: "2026-08-17",
        serviceName: "Haircut",
      })) as { durationMinutes: number };

      expect(serviceFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, name: { equals: "Haircut", mode: "insensitive" } },
        }),
      );
      expect(result.durationMinutes).toBe(45);
    });

    it("falls back to 30 minutes when no service name is given", async () => {
      const result = (await getCalendarAvailability.execute(identity(), {
        date: "2026-08-17",
      })) as { durationMinutes: number };
      expect(serviceFindFirstMock).not.toHaveBeenCalled();
      expect(result.durationMinutes).toBe(30);
    });

    it("falls back to 30 minutes when the named service doesn't match anything (never throws)", async () => {
      serviceFindFirstMock.mockResolvedValueOnce(null);
      const result = (await getCalendarAvailability.execute(identity(), {
        date: "2026-08-17",
        serviceName: "Nonexistent Service",
      })) as { durationMinutes: number };
      expect(result.durationMinutes).toBe(30);
    });

    it("resolves duplicate-name services deterministically (PR #91 review finding: BusinessDnaService.name has no uniqueness constraint)", async () => {
      // The query itself must specify an explicit, stable orderBy - matching
      // listBusinessDnaServices()'s own convention - so that if an org has
      // two services sharing a name, the same one is always picked, not an
      // arbitrary one determined by whatever order Postgres happens to
      // return without an ORDER BY.
      await getCalendarAvailability.execute(identity(), {
        date: "2026-08-17",
        serviceName: "Haircut",
      });
      expect(serviceFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { createdAt: "asc" }],
        }),
      );
    });
  });
});
