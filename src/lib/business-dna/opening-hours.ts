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

function normalizeDay(value: unknown): DayHours {
  if (!value || typeof value !== "object") return { ...DEFAULT_DAY_HOURS };
  const v = value as Record<string, unknown>;
  const open = typeof v.open === "string" && HHMM.test(v.open) ? v.open : DEFAULT_DAY_HOURS.open;
  const close =
    typeof v.close === "string" && HHMM.test(v.close) ? v.close : DEFAULT_DAY_HOURS.close;
  const closed = typeof v.closed === "boolean" ? v.closed : DEFAULT_DAY_HOURS.closed;
  return { closed, open, close };
}

/** `WeekHours` is already shaped exactly like `businessDnaSchema`'s openingHours input. */
export function weekHoursToPayload(hours: WeekHours): OpeningHours {
  return hours;
}
