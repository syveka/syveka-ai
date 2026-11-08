import { describe, expect, it } from "vitest";
import {
  computeAvailableSlots,
  hasConflict,
  intervalsOverlap,
  type WeeklyRule,
} from "@/server/calendar/slots";

const MON_TO_FRI_9_17: WeeklyRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1020,
}));

// Thursday 2026-01-15 (winter, Helsinki UTC+2)
const NOW = new Date("2026-01-14T08:00:00Z");
const FROM = new Date("2026-01-15T00:00:00Z");
const TO = new Date("2026-01-16T00:00:00Z");

function slots(overrides: Partial<Parameters<typeof computeAvailableSlots>[0]> = {}) {
  return computeAvailableSlots({
    timezone: "Europe/Helsinki",
    rules: MON_TO_FRI_9_17,
    overrides: [],
    busy: [],
    from: FROM,
    to: TO,
    now: NOW,
    durationMinutes: 60,
    ...overrides,
  });
}

describe("interval helpers", () => {
  it("detects overlap correctly (half-open intervals)", () => {
    const a = new Date("2026-01-15T10:00:00Z");
    const b = new Date("2026-01-15T11:00:00Z");
    const c = new Date("2026-01-15T12:00:00Z");
    expect(intervalsOverlap(a, b, b, c)).toBe(false); // touching ≠ overlap
    expect(intervalsOverlap(a, c, b, c)).toBe(true);
    expect(hasConflict([{ startsAt: a, endsAt: c }], b, c)).toBe(true);
  });
});

describe("availability calculation", () => {
  it("generates hourly slots inside working hours (timezone-aware)", () => {
    const out = slots();
    // 09:00–17:00 Helsinki = 07:00–15:00Z → 8 one-hour slots
    expect(out).toHaveLength(8);
    expect(out[0]!.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(out[7]!.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("returns nothing on weekends (no matching rule)", () => {
    const out = slots({
      from: new Date("2026-01-17T00:00:00Z"), // Saturday
      to: new Date("2026-01-18T00:00:00Z"),
    });
    expect(out).toHaveLength(0);
  });

  it("busy events block overlapping slots (conflict prevention)", () => {
    const out = slots({
      busy: [
        {
          startsAt: new Date("2026-01-15T08:30:00Z"), // 10:30–11:30 local
          endsAt: new Date("2026-01-15T09:30:00Z"),
        },
      ],
    });
    const iso = out.map((s) => s.toISOString());
    expect(iso).not.toContain("2026-01-15T08:00:00.000Z"); // 10–11 local overlaps
    expect(iso).not.toContain("2026-01-15T09:00:00.000Z"); // 11–12 local overlaps
    expect(iso).toContain("2026-01-15T07:00:00.000Z");
    expect(iso).toContain("2026-01-15T10:00:00.000Z");
  });

  it("buffers extend the blocked window (double-booking protection)", () => {
    const out = slots({
      busy: [
        {
          startsAt: new Date("2026-01-15T09:00:00Z"),
          endsAt: new Date("2026-01-15T10:00:00Z"),
        },
      ],
      bufferBeforeMinutes: 30,
      bufferAfterMinutes: 30,
    });
    const iso = out.map((s) => s.toISOString());
    // Slot 08:00–09:00Z would touch busy start with 30min buffer → blocked.
    expect(iso).not.toContain("2026-01-15T08:00:00.000Z");
    expect(iso).not.toContain("2026-01-15T10:00:00.000Z");
    expect(iso).toContain("2026-01-15T07:00:00.000Z");
  });

  it("minimum notice hides near-term slots", () => {
    const out = slots({
      now: new Date("2026-01-15T06:30:00Z"),
      minNoticeMinutes: 120,
    });
    // Earliest allowed start: 08:30Z → first hourly slot is 09:00Z.
    expect(out[0]!.toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  it("maximum booking window caps the horizon", () => {
    const out = slots({
      from: new Date("2026-01-15T00:00:00Z"),
      to: new Date("2026-02-15T00:00:00Z"),
      now: new Date("2026-01-14T08:00:00Z"),
      maxWindowDays: 2,
    });
    const last = out[out.length - 1]!;
    expect(last.getTime()).toBeLessThanOrEqual(NOW.getTime() + 2 * 86_400_000);
  });

  it("date overrides replace weekly rules", () => {
    const out = slots({
      overrides: [
        { date: "2026-01-15", startMinute: 720, endMinute: 840, isUnavailable: false }, // 12–14
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.toISOString()).toBe("2026-01-15T10:00:00.000Z"); // 12:00 local
  });

  it("unavailable override blanks the day", () => {
    const out = slots({
      overrides: [{ date: "2026-01-15", startMinute: null, endMinute: null, isUnavailable: true }],
    });
    expect(out).toHaveLength(0);
  });

  it("DST spring-forward day: slots stay on the local grid", () => {
    // Sunday 2026-03-29 with a Sunday rule 09–17.
    const out = computeAvailableSlots({
      timezone: "Europe/Helsinki",
      rules: [{ weekday: 0, startMinute: 540, endMinute: 1020 }],
      overrides: [],
      busy: [],
      from: new Date("2026-03-29T00:00:00Z"),
      to: new Date("2026-03-30T00:00:00Z"),
      now: new Date("2026-03-28T00:00:00Z"),
      durationMinutes: 60,
    });
    // 09:00 local is EEST (UTC+3) → 06:00Z on that day.
    expect(out[0]!.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    expect(out).toHaveLength(8);
  });

  // 2026-03-29 in Helsinki: 03:00 local doesn't exist (clocks go 03:00 → 04:00 EEST).
  const SPRING_FORWARD = {
    timezone: "Europe/Helsinki",
    overrides: [],
    busy: [],
    from: new Date("2026-03-28T22:00:00Z"), // local midnight (still EET, UTC+2)
    to: new Date("2026-03-29T21:00:00Z"), // next local midnight (EEST, UTC+3)
    now: new Date("2026-03-28T00:00:00Z"),
    durationMinutes: 60,
  };

  it("DST spring-forward gap: a window across 03:00 offers each real hour once", () => {
    // Sunday rule 02:00–05:00: 02:00 (00:00Z) and 04:00 (01:00Z). The missing 03:00
    // resolves to 04:00 and must not appear as a second 01:00Z slot.
    const out = computeAvailableSlots({
      ...SPRING_FORWARD,
      rules: [{ weekday: 0, startMinute: 120, endMinute: 300 }],
    });
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
    ]);
  });

  it("DST spring-forward day: an all-day window has 23 hourly slots, not 24", () => {
    const out = computeAvailableSlots({
      ...SPRING_FORWARD,
      rules: [{ weekday: 0, startMinute: 0, endMinute: 1440 }],
    });
    expect(out).toHaveLength(23);
    expect(new Set(out.map((d) => d.getTime())).size).toBe(out.length);
  });

  it("overlapping date-override windows give each slot once, sorted", () => {
    // Windows stored in DB order, not time order: 12–14, then 09–13.
    const out = slots({
      overrides: [
        { date: "2026-01-15", startMinute: 720, endMinute: 840, isUnavailable: false },
        { date: "2026-01-15", startMinute: 540, endMinute: 780, isUnavailable: false },
      ],
    });
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-01-15T07:00:00.000Z", // 09:00 local
      "2026-01-15T08:00:00.000Z",
      "2026-01-15T09:00:00.000Z",
      "2026-01-15T10:00:00.000Z",
      "2026-01-15T11:00:00.000Z", // 13:00 local
    ]);
  });

  it("maxSlots keeps the earliest slots of a day whose windows are out of order", () => {
    const out = slots({
      overrides: [
        { date: "2026-01-15", startMinute: 720, endMinute: 840, isUnavailable: false },
        { date: "2026-01-15", startMinute: 540, endMinute: 660, isUnavailable: false },
      ],
      maxSlots: 2,
    });
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-01-15T07:00:00.000Z",
      "2026-01-15T08:00:00.000Z",
    ]);
  });

  it("zero/negative durations yield no slots", () => {
    expect(slots({ durationMinutes: 0 })).toHaveLength(0);
  });
});
