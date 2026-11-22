import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Policy A on the AI paths: a weekday Business DNA marks closed has no slots
 * for the AI availability tool, a phone caller's booking or the booking
 * assistant's suggestions, whatever the availability schedule says.
 */

const { tenantDbMock, dnaFindFirstMock, txMock, transactionMock } = vi.hoisted(() => {
  const txMock = {
    $executeRaw: vi.fn(async () => 0),
    calendarEvent: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    contact: { findFirstOrThrow: vi.fn() },
  };
  return {
    txMock,
    transactionMock: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    tenantDbMock: vi.fn(),
    dnaFindFirstMock: vi.fn(),
  };
});

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: { $transaction: transactionMock },
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

import { TOOL_REGISTRY, type ToolIdentity } from "@/server/ai/tools";
import { suggestAvailableTimes } from "@/server/services/booking-assistant";

const getCalendarAvailability = TOOL_REGISTRY.find((t) => t.name === "getCalendarAvailability")!;
const bookMeeting = TOOL_REGISTRY.find((t) => t.name === "bookMeeting")!;

function identity(overrides: Partial<ToolIdentity> = {}): ToolIdentity {
  return { orgId: "org-a", userId: "user-1", role: "MEMBER", actorType: "user", ...overrides };
}

function ctx(): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId: "org-a", role: "MEMBER", locale: "en" };
}

// Every day 09:00-17:00 in Helsinki (UTC+3 in August).
const EVERY_DAY_SCHEDULE = {
  id: "sched-1",
  timezone: "Europe/Helsinki",
  rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
  overrides: [],
};

// Tuesday 2026-08-18 and Monday 2026-08-17 (Helsinki).
const TUESDAY = "2026-08-18";
const TUESDAY_10_LOCAL = "2026-08-18T07:00:00.000Z";
const MONDAY_10_LOCAL = "2026-08-17T07:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-16T10:00:00.000Z"));
  tenantDbMock.mockReturnValue({
    availabilitySchedule: { findFirst: vi.fn(async () => EVERY_DAY_SCHEDULE) },
    calendarEvent: { findMany: vi.fn(async () => []) },
    businessDnaService: { findFirst: vi.fn(async () => null) },
    businessDNA: { findFirst: dnaFindFirstMock },
  });
  dnaFindFirstMock.mockResolvedValue({ openingHours: { tuesday: { closed: true } } });
  txMock.calendarEvent.findFirst.mockResolvedValue(null);
  txMock.calendarEvent.findMany.mockResolvedValue([]);
  txMock.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AI tools respect Business DNA closed days", () => {
  it("getCalendarAvailability lists no free slots on a closed Tuesday", async () => {
    const result = (await getCalendarAvailability.execute(identity(), { date: TUESDAY })) as {
      freeSlotCount: number;
      freeSlots: string[];
    };
    expect(result.freeSlotCount).toBe(0);
    expect(result.freeSlots).toEqual([]);
  });

  it("getCalendarAvailability is unchanged when the hours are unset", async () => {
    dnaFindFirstMock.mockResolvedValue({ openingHours: null });
    const result = (await getCalendarAvailability.execute(identity(), { date: TUESDAY })) as {
      freeSlots: string[];
    };
    expect(result.freeSlots).toHaveLength(16);
    expect(result.freeSlots).toContain(TUESDAY_10_LOCAL);
  });

  it("a phone caller cannot book a closed Tuesday", async () => {
    const result = await bookMeeting.execute(identity({ actorType: "voice_ai" }), {
      title: "Intro call",
      startsAt: TUESDAY_10_LOCAL,
    });
    expect(result).toEqual({ booked: false, reason: "outside_availability" });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("a phone caller can still book an open day", async () => {
    const result = await bookMeeting.execute(identity({ actorType: "voice_ai" }), {
      title: "Intro call",
      startsAt: MONDAY_10_LOCAL,
    });
    expect(result).toMatchObject({ booked: true });
  });

  it("the booking assistant never suggests a closed Tuesday", async () => {
    const { slots } = await suggestAvailableTimes(ctx(), { daysAhead: 7, limit: 500 });
    const days = new Set(slots.map((s) => s.startsAt.slice(0, 10)));
    expect(days.has(TUESDAY)).toBe(false);
    expect(days.has("2026-08-17")).toBe(true);
  });
});
