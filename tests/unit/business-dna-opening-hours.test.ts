import { describe, expect, it } from "vitest";
import {
  DAY_KEYS,
  DEFAULT_DAY_HOURS,
  normalizeOpeningHours,
  weekHoursToPayload,
} from "@/lib/business-dna/opening-hours";

describe("normalizeOpeningHours", () => {
  it("defaults every day to closed when given null", () => {
    const result = normalizeOpeningHours(null);
    for (const day of DAY_KEYS) {
      expect(result[day]).toEqual(DEFAULT_DAY_HOURS);
    }
  });

  it("defaults every day to closed when given undefined", () => {
    const result = normalizeOpeningHours(undefined);
    expect(result.monday).toEqual(DEFAULT_DAY_HOURS);
  });

  it("defaults every day to closed when given a non-object", () => {
    expect(normalizeOpeningHours("not an object").friday).toEqual(DEFAULT_DAY_HOURS);
    expect(normalizeOpeningHours(42).friday).toEqual(DEFAULT_DAY_HOURS);
  });

  it("carries over a valid open day", () => {
    const result = normalizeOpeningHours({
      monday: { closed: false, open: "08:30", close: "16:00" },
    });
    expect(result.monday).toEqual({ closed: false, open: "08:30", close: "16:00" });
    expect(result.tuesday).toEqual(DEFAULT_DAY_HOURS);
  });

  it("carries over an explicitly closed day without valid times", () => {
    const result = normalizeOpeningHours({ sunday: { closed: true } });
    expect(result.sunday).toEqual({ closed: true, open: "09:00", close: "17:00" });
  });

  it("falls back to default times for a malformed time string", () => {
    const result = normalizeOpeningHours({
      wednesday: { closed: false, open: "9am", close: "17:00" },
    });
    expect(result.wednesday.open).toBe("09:00");
    expect(result.wednesday.close).toBe("17:00");
  });

  it("ignores unknown keys and non-object day values", () => {
    const result = normalizeOpeningHours({
      monday: "not an object",
      notADay: { closed: false, open: "10:00", close: "12:00" },
    });
    expect(result.monday).toEqual(DEFAULT_DAY_HOURS);
  });

  it("always returns exactly the seven expected weekday keys", () => {
    const result = normalizeOpeningHours({});
    expect(Object.keys(result).sort()).toEqual([...DAY_KEYS].sort());
  });
});

describe("weekHoursToPayload", () => {
  it("passes the week hours through unchanged (already schema-shaped)", () => {
    const hours = normalizeOpeningHours({
      monday: { closed: false, open: "08:00", close: "16:00" },
    });
    expect(weekHoursToPayload(hours)).toEqual(hours);
  });
});
