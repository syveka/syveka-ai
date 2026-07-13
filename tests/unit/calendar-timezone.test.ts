import { describe, expect, it } from "vitest";
import {
  getTimezoneOffsetMinutes,
  isValidTimezone,
  localDateOf,
  localDays,
  localIsoDate,
  utcToZoned,
  zonedTimeToUtc,
} from "@/server/calendar/timezone";

describe("timezone validation", () => {
  it("accepts IANA zones and rejects garbage", () => {
    expect(isValidTimezone("Europe/Helsinki")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimezone("not a zone")).toBe(false);
  });
});

describe("offset computation", () => {
  it("Helsinki is UTC+2 in winter and UTC+3 in summer", () => {
    expect(getTimezoneOffsetMinutes("Europe/Helsinki", new Date("2026-01-15T12:00:00Z"))).toBe(120);
    expect(getTimezoneOffsetMinutes("Europe/Helsinki", new Date("2026-07-15T12:00:00Z"))).toBe(180);
  });

  it("New York is UTC-5 in winter and UTC-4 in summer", () => {
    expect(getTimezoneOffsetMinutes("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe(
      -300,
    );
    expect(getTimezoneOffsetMinutes("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe(
      -240,
    );
  });
});

describe("zonedTimeToUtc", () => {
  it("converts Helsinki wall clock to UTC (winter)", () => {
    // 2026-01-15 09:00 Helsinki (UTC+2) = 07:00Z
    const d = zonedTimeToUtc(2026, 1, 15, 9 * 60, "Europe/Helsinki");
    expect(d.toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });

  it("converts Helsinki wall clock to UTC (summer)", () => {
    // 2026-07-15 09:00 Helsinki (UTC+3) = 06:00Z
    const d = zonedTimeToUtc(2026, 7, 15, 9 * 60, "Europe/Helsinki");
    expect(d.toISOString()).toBe("2026-07-15T06:00:00.000Z");
  });

  it("round-trips through utcToZoned", () => {
    const d = zonedTimeToUtc(2026, 3, 10, 14 * 60 + 30, "America/New_York");
    const z = utcToZoned(d, "America/New_York");
    expect([z.year, z.month, z.day, z.hour, z.minute]).toEqual([2026, 3, 10, 14, 30]);
  });
});

describe("DST edge cases (EU transition 2026-03-29 / 2026-10-25)", () => {
  it("spring forward: 03:30 does not exist in Helsinki; resolves deterministically", () => {
    // Clocks jump 03:00 → 04:00 EET→EEST on 2026-03-29.
    const d = zonedTimeToUtc(2026, 3, 29, 3 * 60 + 30, "Europe/Helsinki");
    // 01:30Z would be 03:30 EET (gap) → resolved with post-transition offset: 00:30Z = 03:30 EEST.
    expect(["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z"]).toContain(d.toISOString());
    // Regardless of which side, converting back must land at a real wall time.
    const z = utcToZoned(d, "Europe/Helsinki");
    expect(z.day).toBe(29);
  });

  it("fall back: 03:30 happens twice in Helsinki; picks the post-transition occurrence", () => {
    // Clocks fall 04:00 EEST → 03:00 EET on 2026-10-25.
    const d = zonedTimeToUtc(2026, 10, 25, 3 * 60 + 30, "Europe/Helsinki");
    // Deterministic choice: EET (UTC+2) occurrence at 01:30Z.
    expect(d.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    const z = utcToZoned(d, "Europe/Helsinki");
    expect([z.hour, z.minute]).toEqual([3, 30]);
  });

  it("a 09:00 slot on the spring-forward day is still 09:00 local", () => {
    const d = zonedTimeToUtc(2026, 3, 29, 9 * 60, "Europe/Helsinki");
    const z = utcToZoned(d, "Europe/Helsinki");
    expect([z.hour, z.minute]).toEqual([9, 0]);
    // EEST already active → 06:00Z, not 07:00Z.
    expect(d.toISOString()).toBe("2026-03-29T06:00:00.000Z");
  });
});

describe("localDays iterator", () => {
  it("yields each local day exactly once across a DST transition", () => {
    const from = new Date("2026-03-27T12:00:00Z");
    const to = new Date("2026-03-31T12:00:00Z");
    const days = [...localDays(from, to, "Europe/Helsinki")].map(
      (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`,
    );
    expect(days).toEqual(["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
  });

  it("localIsoDate matches the zone's calendar date near midnight", () => {
    // 22:30Z on Jan 14 is already Jan 15 in Helsinki (UTC+2).
    expect(localIsoDate(new Date("2026-01-14T22:30:00Z"), "Europe/Helsinki")).toBe("2026-01-15");
    expect(localIsoDate(new Date("2026-01-14T22:30:00Z"), "UTC")).toBe("2026-01-14");
  });

  it("localDateOf reports correct weekday", () => {
    // 2026-01-15 is a Thursday (4).
    const d = localDateOf(new Date("2026-01-15T10:00:00Z"), "Europe/Helsinki");
    expect(d.weekday).toBe(4);
  });
});
