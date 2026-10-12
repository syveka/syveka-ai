import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chat may state free times only from getCalendarAvailability in the current
 * turn (staging QA, 2026-10-12: a reply listed a busy 14:00 slot "based on a
 * generic schedule" without looking it up). Covers the tool's description and
 * full, localized output, the system prompt rule, the saved diagnostic
 * details, and parity with the public booking page. The slot calculation
 * itself is unchanged and runs for real here.
 */
const h = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  schedule: null as unknown,
  serviceDuration: null as number | null,
}));

vi.mock("@/server/db/tenant", async () => {
  const { findManyPagedOver, findFirstOver } = await import("./helpers/calendar-event-where");
  const events = (args: never) => findManyPagedOver(h.events as never)(args);
  return {
    tenantDb: () => ({
      availabilitySchedule: { findFirst: async () => h.schedule },
      calendarEvent: { findMany: events },
      businessDnaService: {
        findFirst: async () =>
          h.serviceDuration === null ? null : { durationMinutes: h.serviceDuration },
      },
    }),
    unscopedPrisma: {
      bookingType: {
        findFirst: async () => ({
          id: "bt-1",
          organizationId: "org-a",
          ownerId: "user-1",
          slug: "syveka-qa-booking",
          isActive: true,
          durationMinutes: 30,
          durationOptions: [30],
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          minNoticeMinutes: 0,
          maxWindowDays: 60,
          schedule: null,
          organization: { id: "org-a", name: "QA", slug: "qa", logoUrl: null },
        }),
      },
      organizationMember: { findFirst: async () => ({ id: "m-1" }) },
      availabilitySchedule: {
        findFirst: (args: never) => findFirstOver(h.schedule ? [h.schedule as never] : [])(args),
      },
      calendarEvent: { findMany: events },
    },
  };
});
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));

import { TOOL_REGISTRY, anthropicToolsFor, type ToolIdentity } from "@/server/ai/tools";
import { buildSystemPrompt } from "@/server/ai/prompts/system";
import { toolCallDetails } from "@/server/ai/tool-call-log";
import { getPublicSlots } from "@/server/services/booking";

const tool = TOOL_REGISTRY.find((t) => t.name === "getCalendarAvailability")!;

type Availability = {
  date: string;
  timezone: string;
  freeSlotCount: number;
  freeSlots: string[];
  localTimes: string[];
  moreSlotsAvailable: boolean;
  usingOrgConfiguredHours: boolean;
};

const member: ToolIdentity = {
  orgId: "org-a",
  userId: "user-1",
  role: "MEMBER",
  actorType: "user",
};

async function availability(date: string): Promise<Availability> {
  return (await tool.execute(member, { date })) as Availability;
}

function series(id: string, startsAt: string, minutes: number) {
  const start = new Date(startsAt);
  return {
    id,
    organizationId: "org-a",
    ownerId: "user-1",
    createdById: "user-1",
    deletedAt: null,
    status: "CONFIRMED",
    startsAt: start,
    endsAt: new Date(start.getTime() + minutes * 60_000),
    recurrenceRule: "FREQ=WEEKLY",
    timezone: "Europe/Helsinki",
  };
}

const helsinki = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

beforeEach(() => {
  // Before every date used below, so no slot is clamped as already past.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  h.events = [];
  h.schedule = null;
  h.serviceDuration = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getCalendarAvailability output", () => {
  it("A: a whole 09:00-17:00 day returns all 16 slots, not the first 12", async () => {
    const result = await availability("2026-10-19");

    expect(result.freeSlots).toHaveLength(16);
    expect(result.freeSlotCount).toBe(16);
    expect(result.moreSlotsAvailable).toBe(false);
    expect(result.localTimes[0]).toBe("09:00");
    expect(result.localTimes.at(-1)).toBe("16:30");
    expect(result.usingOrgConfiguredHours).toBe(false);
  });

  it("A: past the listing cap it says more slots exist and gives the full count", async () => {
    h.serviceDuration = 15;
    h.schedule = {
      id: "s-1",
      organizationId: "org-a",
      userId: "user-1",
      isDefault: true,
      timezone: "Europe/Helsinki",
      rules: [{ weekday: 1, startMinute: 0, endMinute: 24 * 60 }],
      overrides: [],
    };

    // A 15-minute service around the clock: 96 free slots.
    const result = (await tool.execute(member, {
      date: "2026-10-19",
      serviceName: "Quick check",
    })) as Availability;

    expect(result.freeSlotCount).toBe(96);
    expect(result.freeSlots).toHaveLength(48);
    expect(result.localTimes).toHaveLength(48);
    expect(result.moreSlotsAvailable).toBe(true);
  });

  it("B: a weekly 14:00-14:30 Helsinki series excludes 14:00 and keeps 14:30 on 2026-10-19", async () => {
    h.events = [series("qa-recurring", "2026-10-05T11:00:00.000Z", 30)];

    const result = await availability("2026-10-19");

    expect(result.freeSlots).not.toContain("2026-10-19T11:00:00.000Z");
    expect(result.freeSlots).toContain("2026-10-19T11:30:00.000Z");
    expect(result.localTimes).not.toContain("14:00");
    expect(result.localTimes).toContain("14:30");
    expect(result.freeSlotCount).toBe(15);
  });

  it("C: a weekly 16:00 series stays at 16:00 local after the 2026-10-25 clock change", async () => {
    // 16:00 EEST (UTC+3) on 2026-10-19; a week later Helsinki is on EET (UTC+2).
    h.events = [series("qa-dst-weekly", "2026-10-19T13:00:00.000Z", 30)];

    const before = await availability("2026-10-19");
    const after = await availability("2026-10-26");

    expect(before.localTimes).not.toContain("16:00");
    expect(before.freeSlots).not.toContain("2026-10-19T13:00:00.000Z");
    expect(after.localTimes).not.toContain("16:00");
    expect(after.freeSlots).not.toContain("2026-10-26T14:00:00.000Z");
    // Only that slot is busy: the hour after the clock change is still free.
    expect(after.localTimes).toContain("15:30");
    expect(after.localTimes).toContain("16:30");
    expect(after.freeSlots).toContain("2026-10-26T13:00:00.000Z");
  });

  it("D: localTimes are exactly the UTC slots as Helsinki wall-clock times, on both sides of DST", async () => {
    for (const date of ["2026-10-19", "2026-10-26"]) {
      const result = await availability(date);
      expect(result.timezone).toBe("Europe/Helsinki");
      expect(result.localTimes).toEqual(result.freeSlots.map(helsinki));
      expect(result.localTimes[0]).toBe("09:00");
    }
    expect((await availability("2026-10-19")).freeSlots[0]).toBe("2026-10-19T06:00:00.000Z");
    expect((await availability("2026-10-26")).freeSlots[0]).toBe("2026-10-26T07:00:00.000Z");
  });
});

describe("the model is told to look availability up", () => {
  it("E: the tool description requires a lookup and gives no opening hours to quote", () => {
    expect(tool.description).toContain(
      "Always call this tool before stating free times or availability for a specific date/time. Never answer availability from memory or an earlier assistant reply.",
    );
    expect(tool.description).not.toMatch(/\d{1,2}:\d{2}/);
    expect(tool.description).not.toMatch(/mon\s*-\s*fri/i);
  });

  it.each(["en", "fi", "ar"])(
    "F: the %s system prompt requires a lookup in this turn and forbids guessing",
    (locale) => {
      const prompt = buildSystemPrompt({
        locale,
        org: { name: "Acme" },
        ragContext: [],
        hasTools: true,
      });
      expect(prompt).toContain(
        "call getCalendarAvailability for that date in this turn, and state only what it returned",
      );
      expect(prompt).toContain(
        "Never infer availability from generic or default hours, the business profile's opening hours, memory, or earlier messages",
      );
      expect(prompt).toContain(
        "say that you couldn't check availability right now instead of guessing",
      );
    },
  );

  it("F: the rule stays in a live voice turn", () => {
    const prompt = buildSystemPrompt({
      locale: "en",
      org: { name: "Acme" },
      ragContext: [],
      hasTools: true,
      responseMode: "voice",
    });
    expect(prompt).toContain("call getCalendarAvailability for that date in this turn");
  });

  it("H: MEMBER users are still offered getCalendarAvailability", () => {
    expect(anthropicToolsFor(member).map((t) => t.name)).toContain("getCalendarAvailability");
  });
});

describe("G: what a reply saves about an availability lookup", () => {
  it("the requested date, the slot count and the hours flag -- not the result", async () => {
    h.events = [series("qa-recurring", "2026-10-05T11:00:00.000Z", 30)];
    const result = JSON.stringify(await availability("2026-10-19"));

    const details = toolCallDetails("getCalendarAvailability", { date: "2026-10-19" }, result);

    expect(details).toEqual({
      date: "2026-10-19",
      freeSlotCount: 15,
      usingOrgConfiguredHours: false,
    });
    const saved = JSON.stringify({ name: "getCalendarAvailability", ok: true, details });
    expect(saved).not.toContain("freeSlots");
    expect(saved).not.toContain("localTimes");
    expect(saved).not.toMatch(/T\d{2}:\d{2}/);
  });

  it("stores no input from other tools (searches can hold personal data)", () => {
    expect(toolCallDetails("searchContacts", { query: "Jane Doe" }, "[]")).toBeUndefined();
    expect(toolCallDetails("searchKnowledgeBase", { query: "refunds" }, "[]")).toBeUndefined();
  });

  it("keeps only a well-formed date, and survives an error result", () => {
    expect(
      toolCallDetails("getCalendarAvailability", { date: "Jane Doe" }, '{"error":"invalid_input"}'),
    ).toEqual({});
  });
});

describe("I: chat and the public booking page agree", () => {
  it.each(["2026-10-19", "2026-10-26"])(
    "same owner, events and (default) schedule give the same slots on %s",
    async (date) => {
      h.events = [
        series("qa-recurring", "2026-10-05T11:00:00.000Z", 30),
        series("qa-dst-weekly", "2026-10-19T13:00:00.000Z", 30),
      ];
      const chat = await availability(date);
      const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
      const { zonedTimeToUtc, addDaysUtc } = await import("@/server/calendar/timezone");
      const from = zonedTimeToUtc(y, mo, d, 0, "Europe/Helsinki");

      const booking = await getPublicSlots({
        orgSlug: "qa",
        typeSlug: "syveka-qa-booking",
        from,
        to: addDaysUtc(from, 1),
        now: new Date(),
      });

      expect(booking.timezone).toBe(chat.timezone);
      expect(booking.slots.map((s) => s.toISOString())).toEqual(chat.freeSlots);
    },
  );
});
