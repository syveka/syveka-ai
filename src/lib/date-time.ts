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

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  // Newer Intl accepts UTC-offset zones like "+03:00". Those are fixed
  // offsets that ignore DST, so they are never a valid display zone here.
  if (/^[+-]/.test(value.trim())) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
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
