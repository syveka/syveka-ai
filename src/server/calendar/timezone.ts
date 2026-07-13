/**
 * Timezone math without external dependencies (Intl-based).
 * All functions are pure; DST transitions are handled by the double-pass
 * offset resolution in `zonedTimeToUtc`.
 */

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = offsetFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    offsetFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
};

/** Wall-clock parts of a UTC instant in the given timezone. */
export function utcToZoned(date: Date, timeZone: string): ZonedParts {
  const parts = offsetFormatter(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl renders midnight as hour 24 in some locales/options; normalize.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** UTC-offset (minutes east of UTC) of `timeZone` at the given instant. */
export function getTimezoneOffsetMinutes(timeZone: string, date: Date): number {
  const z = utcToZoned(date, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant.
 * `minuteOfDay` is minutes from local midnight (0-1439).
 *
 * DST notes: during a spring-forward gap the non-existent local time resolves
 * to a real instant adjacent to the jump; during a fall-back overlap the
 * post-transition occurrence is chosen. Deterministic in both cases.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  // First guess with the offset at the naive instant, then refine once —
  // converges for all real-world transitions (offsets change by ≤ 2h).
  let offset = getTimezoneOffsetMinutes(timeZone, new Date(naive));
  let result = naive - offset * 60_000;
  offset = getTimezoneOffsetMinutes(timeZone, new Date(result));
  result = naive - offset * 60_000;
  return new Date(result);
}

/** Local calendar date (y/m/d + weekday 0=Sun) of a UTC instant in `timeZone`. */
export function localDateOf(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minuteOfDay: number;
} {
  const z = utcToZoned(date, timeZone);
  // Weekday from the local calendar date (Zeller-free: use UTC Date of local y/m/d).
  const weekday = new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay();
  return {
    year: z.year,
    month: z.month,
    day: z.day,
    weekday,
    minuteOfDay: z.hour * 60 + z.minute,
  };
}

/** ISO `YYYY-MM-DD` of a UTC instant in `timeZone`. */
export function localIsoDate(date: Date, timeZone: string): string {
  const z = utcToZoned(date, timeZone);
  const mm = String(z.month).padStart(2, "0");
  const dd = String(z.day).padStart(2, "0");
  return `${z.year}-${mm}-${dd}`;
}

export function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Iterate local calendar days (as `{year, month, day, weekday}`) covering [from, to] in `timeZone`. */
export function* localDays(
  from: Date,
  to: Date,
  timeZone: string,
): Generator<{ year: number; month: number; day: number; weekday: number; dayStartUtc: Date }> {
  // Start at local midnight of `from`'s local date.
  let z = utcToZoned(from, timeZone);
  let cursor = zonedTimeToUtc(z.year, z.month, z.day, 0, timeZone);
  let guard = 0;
  while (cursor <= to && guard < 400) {
    z = utcToZoned(cursor, timeZone);
    const weekday = new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay();
    yield { year: z.year, month: z.month, day: z.day, weekday, dayStartUtc: cursor };
    // Jump ~1 day then snap to next local midnight (robust across 23/25h days).
    const next = new Date(cursor.getTime() + 26 * 3_600_000);
    const nz = utcToZoned(next, timeZone);
    cursor = zonedTimeToUtc(nz.year, nz.month, nz.day, 0, timeZone);
    guard += 1;
  }
}
