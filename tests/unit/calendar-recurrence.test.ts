import { describe, expect, it } from "vitest";
import {
  expandOccurrences,
  parseRecurrenceRule,
  RecurrenceError,
  validateRecurrenceRule,
} from "@/server/calendar/recurrence";

describe("recurrence rule validation", () => {
  it("parses a plain weekly rule", () => {
    const r = parseRecurrenceRule("FREQ=WEEKLY");
    expect(r).toMatchObject({ freq: "WEEKLY", interval: 1 });
  });

  it("parses RRULE: prefix, INTERVAL, COUNT and BYDAY", () => {
    const r = parseRecurrenceRule("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10;BYDAY=MO,WE,FR");
    expect(r).toMatchObject({ freq: "WEEKLY", interval: 2, count: 10, byDay: [1, 3, 5] });
  });

  it("parses UNTIL dates", () => {
    const r = parseRecurrenceRule("FREQ=DAILY;UNTIL=20260401");
    expect(r.until?.toISOString().slice(0, 10)).toBe("2026-04-01");
  });

  it.each([
    ["", "invalid_format"],
    ["FREQ=YEARLY", "unsupported_freq"],
    ["FREQ=DAILY;INTERVAL=0", "invalid_interval"],
    ["FREQ=DAILY;INTERVAL=999", "invalid_interval"],
    ["FREQ=DAILY;COUNT=0", "invalid_count"],
    ["FREQ=DAILY;COUNT=99999", "invalid_count"],
    ["FREQ=DAILY;UNTIL=tomorrow", "invalid_until"],
    ["FREQ=DAILY;COUNT=5;UNTIL=20261231", "count_and_until"],
    ["FREQ=DAILY;BYDAY=MO", "invalid_byday"],
    ["FREQ=WEEKLY;BYDAY=XX", "invalid_byday"],
  ])("rejects %s with %s", (rule, code) => {
    try {
      validateRecurrenceRule(rule);
      throw new Error("expected RecurrenceError");
    } catch (e) {
      expect(e).toBeInstanceOf(RecurrenceError);
      expect((e as RecurrenceError).code).toBe(code);
    }
  });
});

describe("occurrence expansion", () => {
  const base = {
    seriesStart: new Date("2026-01-05T09:00:00Z"), // Monday
    seriesEnd: new Date("2026-01-05T10:00:00Z"),
  };

  it("expands daily occurrences within range", () => {
    const out = expandOccurrences({
      ...base,
      rule: parseRecurrenceRule("FREQ=DAILY"),
      rangeFrom: new Date("2026-01-05T00:00:00Z"),
      rangeTo: new Date("2026-01-08T00:00:00Z"),
    });
    expect(out.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
    ]);
    // Duration preserved
    expect(out[0]!.endsAt.getTime() - out[0]!.startsAt.getTime()).toBe(3_600_000);
  });

  it("respects COUNT", () => {
    const out = expandOccurrences({
      ...base,
      rule: parseRecurrenceRule("FREQ=DAILY;COUNT=2"),
      rangeFrom: new Date("2026-01-01T00:00:00Z"),
      rangeTo: new Date("2026-02-01T00:00:00Z"),
    });
    expect(out).toHaveLength(2);
  });

  it("respects UNTIL", () => {
    const out = expandOccurrences({
      ...base,
      rule: parseRecurrenceRule("FREQ=DAILY;UNTIL=20260107"),
      rangeFrom: new Date("2026-01-01T00:00:00Z"),
      rangeTo: new Date("2026-02-01T00:00:00Z"),
    });
    expect(out).toHaveLength(3); // 5th, 6th, 7th
  });

  it("expands weekly BYDAY on the right weekdays", () => {
    const out = expandOccurrences({
      ...base,
      rule: parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4"),
      rangeFrom: new Date("2026-01-01T00:00:00Z"),
      rangeTo: new Date("2026-02-01T00:00:00Z"),
    });
    const days = out.map((o) => o.startsAt.getUTCDay());
    expect(days).toEqual([1, 5, 1, 5]);
  });

  it("monthly on the 31st skips short months", () => {
    const out = expandOccurrences({
      seriesStart: new Date("2026-01-31T09:00:00Z"),
      seriesEnd: new Date("2026-01-31T09:30:00Z"),
      rule: parseRecurrenceRule("FREQ=MONTHLY"),
      rangeFrom: new Date("2026-01-01T00:00:00Z"),
      rangeTo: new Date("2026-06-01T00:00:00Z"),
    });
    const dates = out.map((o) => o.startsAt.toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]); // no Feb/Apr
  });

  it("caps runaway expansion", () => {
    const out = expandOccurrences({
      ...base,
      rule: parseRecurrenceRule("FREQ=DAILY"),
      rangeFrom: new Date("2020-01-01T00:00:00Z"),
      rangeTo: new Date("2030-01-01T00:00:00Z"),
      max: 5000,
    });
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
