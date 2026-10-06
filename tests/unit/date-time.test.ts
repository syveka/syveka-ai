import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  formatDateTimeInTimeZone,
  isValidTimeZone,
  resolveDisplayTimeZone,
} from "@/lib/date-time";

/** Wall-clock parts of an instant in a zone, independent of locale digits. */
function wallClock(iso: string, timeZone: string | null | undefined) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: resolveDisplayTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

const toLatinDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

describe("resolveDisplayTimeZone", () => {
  it("uses the viewer's valid IANA zone", () => {
    expect(resolveDisplayTimeZone("Europe/Stockholm")).toBe("Europe/Stockholm");
    expect(resolveDisplayTimeZone("UTC")).toBe("UTC");
  });

  it.each([null, undefined, "", "   ", "Mars/Olympus_Mons", "+03:00", "EEST"])(
    "falls back to %s -> Europe/Helsinki",
    (value) => {
      expect(resolveDisplayTimeZone(value as string | null | undefined)).toBe("Europe/Helsinki");
    },
  );

  it("exposes Helsinki as the single app default", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Europe/Helsinki");
    expect(isValidTimeZone(DEFAULT_TIME_ZONE)).toBe(true);
  });
});

describe("Helsinki wall-clock time (DST handled by zone rules, never a fixed offset)", () => {
  it("summer time (EEST, UTC+3): the observed org.create event", () => {
    // Stored instant 20:28:05 UTC was created at ~23:28 Helsinki.
    expect(wallClock("2026-09-27T20:28:05Z", "Europe/Helsinki")).toBe("2026-09-27 23:28:05");
  });

  it("winter time (EET, UTC+2)", () => {
    expect(wallClock("2026-01-15T10:00:00Z", "Europe/Helsinki")).toBe("2026-01-15 12:00:00");
  });

  it("spring-forward boundary (last Sunday of March 2026)", () => {
    expect(wallClock("2026-03-29T00:59:59Z", "Europe/Helsinki")).toBe("2026-03-29 02:59:59");
    expect(wallClock("2026-03-29T01:00:00Z", "Europe/Helsinki")).toBe("2026-03-29 04:00:00");
  });

  it("fall-back boundary (last Sunday of October 2026): 03:30 occurs twice", () => {
    expect(wallClock("2026-10-25T00:30:00Z", "Europe/Helsinki")).toBe("2026-10-25 03:30:00");
    expect(wallClock("2026-10-25T01:30:00Z", "Europe/Helsinki")).toBe("2026-10-25 03:30:00");
  });

  it("date rollover: 21:30 UTC is already the next day in Helsinki (summer)", () => {
    expect(wallClock("2026-09-27T21:30:00Z", "Europe/Helsinki")).toBe("2026-09-28 00:30:00");
    expect(wallClock("2026-09-27T21:30:00Z", "UTC")).toBe("2026-09-27 21:30:00");
  });

  it("date rollover in winter: 22:30 UTC on 31 Dec is New Year in Helsinki", () => {
    expect(wallClock("2026-12-31T22:30:00Z", "Europe/Helsinki")).toBe("2027-01-01 00:30:00");
  });

  it("an invalid stored zone still renders Helsinki time, not runtime/UTC time", () => {
    expect(wallClock("2026-09-27T20:28:05Z", "Not/AZone")).toBe("2026-09-27 23:28:05");
  });
});

describe("formatDateTimeInTimeZone (locale-formatted output)", () => {
  const instant = "2026-09-27T20:28:05Z";

  it("Finnish: 27.9.2026 klo 23.28.05", () => {
    const out = formatDateTimeInTimeZone(instant, "fi", "Europe/Helsinki");
    expect(out).toContain("27.9.2026");
    expect(out).toContain("23.28.05");
  });

  it("English: 11:28:05 PM on 9/27/26", () => {
    const out = formatDateTimeInTimeZone(instant, "en", "Europe/Helsinki");
    expect(out).toContain("9/27/26");
    expect(out).toMatch(/11:28:05\s?PM/);
  });

  it("Arabic: same wall-clock time (digit system aside)", () => {
    const out = toLatinDigits(formatDateTimeInTimeZone(instant, "ar", "Europe/Helsinki"));
    expect(out).toContain("11:28:05");
  });

  it("formats rollover in the viewer's zone, including the date", () => {
    const out = formatDateTimeInTimeZone("2026-09-27T21:30:00Z", "fi", "Europe/Helsinki");
    expect(out).toContain("28.9.2026");
    expect(out).toContain("0.30.00");
  });

  it("honours a different valid viewer zone (UTC shows the stored instant)", () => {
    expect(formatDateTimeInTimeZone(instant, "fi", "UTC")).toContain("20.28.05");
  });
});
