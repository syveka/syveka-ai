import { describe, expect, it } from "vitest";
import { isZonelessWallTime, toZonedWallTime, zonedWallTimeToUtc } from "@/lib/date-time";

/**
 * Wall-clock times are always read and written in an IANA zone's own rules.
 * Staging QA (2026-10-07): a public booking for 09:00 Europe/Helsinki was
 * stored correctly as 06:00Z but the event editor showed "06:00" next to
 * "Europe/Helsinki" -- the UTC digits printed as Helsinki wall time.
 */
describe("zonedWallTimeToUtc / toZonedWallTime", () => {
  it.each([
    // zone, wall time, expected instant
    ["Europe/Helsinki", "2026-10-07T09:00", "2026-10-07T06:00:00.000Z"], // EEST, UTC+3
    ["Europe/Helsinki", "2026-12-07T09:00", "2026-12-07T07:00:00.000Z"], // EET, UTC+2
    ["UTC", "2026-10-07T09:00", "2026-10-07T09:00:00.000Z"],
    ["America/New_York", "2026-10-07T09:00", "2026-10-07T13:00:00.000Z"], // EDT, UTC-4
    ["America/New_York", "2026-12-07T09:00", "2026-12-07T14:00:00.000Z"], // EST, UTC-5
    ["Asia/Kolkata", "2026-10-07T09:00", "2026-10-07T03:30:00.000Z"], // UTC+5:30, no DST
    ["Asia/Tokyo", "2026-10-07T00:30", "2026-10-06T15:30:00.000Z"], // previous UTC day
    ["Pacific/Auckland", "2026-10-07T09:00", "2026-10-06T20:00:00.000Z"], // NZDT, UTC+13
  ])("%s %s is %s, and back", (zone, wall, instant) => {
    expect(zonedWallTimeToUtc(wall, zone).toISOString()).toBe(instant);
    expect(toZonedWallTime(instant, zone)).toBe(wall);
  });

  it("the exact staging case: the booked instant reads 09:00 in Helsinki, not 06:00", () => {
    expect(toZonedWallTime("2026-10-07T06:00:00.000Z", "Europe/Helsinki")).toBe("2026-10-07T09:00");
  });

  it("a nonexistent time (clocks go forward) moves forward by the gap", () => {
    // Helsinki skips 03:00-04:00 on 2026-03-29.
    const instant = zonedWallTimeToUtc("2026-03-29T03:30", "Europe/Helsinki");
    expect(instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(toZonedWallTime(instant, "Europe/Helsinki")).toBe("2026-03-29T04:30");
  });

  it("a repeated time (clocks go back) takes the later occurrence, as availability slots do", () => {
    // Helsinki repeats 03:00-04:00 on 2026-10-25 (EEST, then EET). The
    // calendar's own zone math (also used for slots) picks the EET one.
    expect(zonedWallTimeToUtc("2026-10-25T03:30", "Europe/Helsinki").toISOString()).toBe(
      "2026-10-25T01:30:00.000Z",
    );
    expect(toZonedWallTime("2026-10-25T00:30:00.000Z", "Europe/Helsinki")).toBe("2026-10-25T03:30");
    expect(toZonedWallTime("2026-10-25T01:30:00.000Z", "Europe/Helsinki")).toBe("2026-10-25T03:30");
  });

  it.each(["Europe/Helsinki", "America/New_York", "UTC", "Australia/Sydney"])(
    "%s: every hour of 2026 round-trips (every transition in these zones is on the hour)",
    (zone) => {
      const start = Date.UTC(2026, 0, 1);
      for (let t = start; t < Date.UTC(2027, 0, 1); t += 60 * 60_000) {
        const wall = toZonedWallTime(new Date(t), zone);
        const back = zonedWallTimeToUtc(wall, zone).getTime();
        // Every wall time round-trips to the same wall time, at one of its
        // real occurrences (a repeated hour has two, an hour apart). Which
        // one is the calendar zone math's choice: the later one east of UTC
        // (Helsinki), the earlier one west of it (New York).
        expect(toZonedWallTime(new Date(back), zone)).toBe(wall);
        expect(Math.abs(back - t) === 0 || Math.abs(back - t) === 3_600_000).toBe(true);
      }
    },
    30_000,
  );

  it("rejects malformed input and unknown or fixed-offset zones", () => {
    expect(() => zonedWallTimeToUtc("2026-10-07 09:00", "Europe/Helsinki")).toThrow(RangeError);
    expect(() => zonedWallTimeToUtc("2026-10-07T09:00", "Mars/Olympus")).toThrow(RangeError);
    expect(() => zonedWallTimeToUtc("2026-10-07T09:00", "+03:00")).toThrow(RangeError);
  });

  it("recognizes only zoneless wall times", () => {
    expect(isZonelessWallTime("2026-10-07T09:00")).toBe(true);
    expect(isZonelessWallTime("2026-10-07T09:00:30")).toBe(true);
    expect(isZonelessWallTime("2026-10-07T06:00:00.000Z")).toBe(false);
    expect(isZonelessWallTime("2026-10-07T09:00+03:00")).toBe(false);
  });
});
