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
  });
});
