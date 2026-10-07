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
import { utcToZoned, zonedTimeToUtc } from "@/server/calendar/timezone";

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
 * fixed offset. The zone math is the calendar's own (src/server/calendar/
 * timezone.ts, pure Intl, also used for availability slots), so the editor
 * and slot generation resolve DST the same way: a skipped time moves
 * forward, a repeated time takes the later (post-transition) occurrence.
 */
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isZonelessWallTime(value: string): boolean {
  return WALL_TIME.test(value);
}

/** An instant as the wall-clock time ("YYYY-MM-DDTHH:mm") it shows in a zone. */
export function toZonedWallTime(instant: Date | string, timeZone: string): string {
  const p = utcToZoned(new Date(instant), resolveDisplayTimeZone(timeZone));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The instant a wall-clock time names in a zone (DST policy above). */
export function zonedWallTimeToUtc(wallTime: string, timeZone: string): Date {
  const m = WALL_TIME.exec(wallTime);
  if (!m) throw new RangeError("Expected a wall-clock time like 2026-10-07T09:00");
  if (!isValidTimeZone(timeZone)) throw new RangeError("Unknown time zone");
  const [, y, mo, d, h, mi, s] = m;
  const minuteOfDay = Number(h) * 60 + Number(mi);
  const instant = zonedTimeToUtc(Number(y), Number(mo), Number(d), minuteOfDay, timeZone);
  return new Date(instant.getTime() + Number(s ?? 0) * 1000);
}
