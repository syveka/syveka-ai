/**
 * Display-time policy for instants stored in the database (e.g. audit log
 * `createdAt`, which Prisma writes as `now()` and returns as a JS Date).
 *
 * `Intl.DateTimeFormat` without an explicit `timeZone` formats in the
 * *runtime's* zone: UTC on Vercel's servers, the browser's zone on clients.
 * So a server-rendered "23:28 Helsinki" event printed as 20:28. Always pass
 * an explicit IANA zone instead.
 *
 * Source of truth: the viewer's profile timezone (`User.timezone`, editable in
 * Settings → Profile). Fallback: the app default below — also the next-intl
 * request default (`src/i18n/request.ts`) — used whenever the stored value is
 * missing or not a zone this runtime's tz database knows (the profile action
 * only length-checks it). Never a fixed offset: the zone rules handle DST.
 */
export const DEFAULT_TIME_ZONE = "Europe/Helsinki";

const zoneValidity = new Map<string, boolean>();

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  // Newer Intl accepts UTC-offset zones like "+03:00". Those are fixed
  // offsets that ignore DST, so they are never a valid display zone here.
  if (/^[+-]/.test(value.trim())) return false;
  const known = zoneValidity.get(value);
  if (known !== undefined) return known;
  let valid: boolean;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    valid = true;
  } catch {
    valid = false;
  }
  // Bounded: arbitrary strings (e.g. form input) must not grow it forever.
  if (zoneValidity.size < 1000) zoneValidity.set(value, valid);
  return valid;
}

export function resolveDisplayTimeZone(preferred: string | null | undefined): string {
  return isValidTimeZone(preferred) ? preferred : DEFAULT_TIME_ZONE;
}

/** Formats an instant in an explicit IANA zone (validated, with fallback). */
export function formatDateTimeInTimeZone(
  date: Date | string,
  locale: string,
  timeZone: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "medium" },
): string {
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: resolveDisplayTimeZone(timeZone),
  }).format(new Date(date));
}

/**
 * Wall-clock values for `<input type="datetime-local">` ("YYYY-MM-DDTHH:mm").
 * Such a value names a time in a zone, not an instant: it must be read and
 * written in that zone's IANA rules, never in the runtime's own zone (UTC
 * on Vercel's servers, the browser's zone on clients) and never with a
 * fixed offset.
 */
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isZonelessWallTime(value: string): boolean {
  return WALL_TIME.test(value);
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(instantMs: number, timeZone: string) {
  let fmt = wallFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's UTC offset at an instant, in milliseconds (DST-aware). */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = wallParts(instantMs, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/** An instant as the wall-clock time ("YYYY-MM-DDTHH:mm") it shows in a zone. */
export function toZonedWallTime(instant: Date | string, timeZone: string): string {
  const p = wallParts(new Date(instant).getTime(), resolveDisplayTimeZone(timeZone));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The instant a wall-clock time names in a zone. Ambiguous times (the hour
 * repeated when clocks go back) resolve to the earlier instant; nonexistent
 * times (skipped when clocks go forward) move forward by the gap, as
 * Temporal's "compatible" disambiguation does.
 */
export function zonedWallTimeToUtc(wallTime: string, timeZone: string): Date {
  const m = WALL_TIME.exec(wallTime);
  if (!m) throw new RangeError("Expected a wall-clock time like 2026-10-07T09:00");
  if (!isValidTimeZone(timeZone)) throw new RangeError("Unknown time zone");
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const wanted = toZonedWallTime(new Date(asUtc), "UTC");
  // Zone offsets change at most once within a day around any instant, so the
  // offsets a day before and a day after cover both sides of a transition.
  const before = offsetMs(asUtc - 86_400_000, timeZone);
  const after = offsetMs(asUtc + 86_400_000, timeZone);
  const matches = [...new Set([asUtc - before, asUtc - after])]
    .filter((c) => toZonedWallTime(new Date(c), timeZone) === wanted)
    .sort((a, b) => a - b);
  if (matches.length > 0) return new Date(matches[0]!);
  // In a gap: use the offset in effect before the transition, which lands
  // after the gap.
  return new Date(asUtc - before);
}
