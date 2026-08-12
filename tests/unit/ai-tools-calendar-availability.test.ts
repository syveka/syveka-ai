import { beforeEach, describe, expect, it, vi } from "vitest";

const { tenantDbMock, scheduleFindFirstMock, eventFindManyMock, auditMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  scheduleFindFirstMock: vi.fn(),
  eventFindManyMock: vi.fn(async () => [] as { startsAt: Date; endsAt: Date }[]),
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
    tenantDbMock.mockReturnValue({
      availabilitySchedule: { findFirst: scheduleFindFirstMock },
      calendarEvent: { findMany: eventFindManyMock },
    });
    scheduleFindFirstMock.mockResolvedValue(null);
    eventFindManyMock.mockResolvedValue([]);
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
});
