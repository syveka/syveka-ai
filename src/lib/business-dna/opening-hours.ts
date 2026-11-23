import type { OpeningHours } from "@/lib/validators/business-dna";

export const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

export type DayHours = { closed: boolean; open: string; close: string };

export type WeekHours = Record<DayKey, DayHours>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_DAY_HOURS: DayHours = { closed: true, open: "09:00", close: "17:00" };

/**
 * Defensively parses whatever is stored in `BusinessDNA.openingHours` (a
 * Prisma `Json` column — no runtime shape guarantee) into a complete
 * 7-day structure the editor can always render safely. Missing or
 * malformed days fall back to a closed default rather than throwing.
 */
export function normalizeOpeningHours(raw: unknown): WeekHours {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<DayKey, unknown>>;

  return Object.fromEntries(DAY_KEYS.map((day) => [day, normalizeDay(source[day])])) as WeekHours;
}

/**
 * The week the Business DNA form shows when nothing is saved: Mon-Fri
 * 09:00-17:00 and a closed weekend, as the booking calendar's own default
 * weekly schedule (DEFAULT_WEEKLY_RULES). Display only: the form sends opening
 * hours only once the user changes a day, so this is never stored by itself.
 * A saved week, even a partial or all-closed one, shows as normalizeOpeningHours
 * reads it.
 */
export function openingHoursForForm(raw: unknown): WeekHours {
  if (raw && typeof raw === "object") return normalizeOpeningHours(raw);
  return Object.fromEntries(
    DAY_KEYS.map((day) => [
      day,
      { ...DEFAULT_DAY_HOURS, closed: day === "saturday" || day === "sunday" },
    ]),
  ) as WeekHours;
}

function normalizeDay(value: unknown): DayHours {
  if (!value || typeof value !== "object") return { ...DEFAULT_DAY_HOURS };
  const v = value as Record<string, unknown>;
  const open = typeof v.open === "string" && HHMM.test(v.open) ? v.open : DEFAULT_DAY_HOURS.open;
  const close =
    typeof v.close === "string" && HHMM.test(v.close) ? v.close : DEFAULT_DAY_HOURS.close;
  const closed = typeof v.closed === "boolean" ? v.closed : DEFAULT_DAY_HOURS.closed;
  return { closed, open, close };
}

/**
 * The weekdays (0 = Sunday, as in the calendar's `localDays`) that the stored
 * `BusinessDNA.openingHours` explicitly marks `closed: true`. Unlike
 * `normalizeOpeningHours`, a missing, malformed or unset day is NOT closed:
 * only an explicit closed day blocks booking.
 */
export function closedWeekdays(raw: unknown): number[] {
  if (!raw || typeof raw !== "object") return [];
  const source = raw as Partial<Record<DayKey, unknown>>;
  return DAY_KEYS.flatMap((day, index) => {
    const value = source[day];
    const closed =
      !!value && typeof value === "object" && (value as Record<string, unknown>).closed === true;
    // DAY_KEYS starts on Monday (1); Sunday is last (0).
    return closed ? [(index + 1) % 7] : [];
  });
}

/** `WeekHours` is already shaped exactly like `businessDnaSchema`'s openingHours input. */
export function weekHoursToPayload(hours: WeekHours): OpeningHours {
  return hours;
}
