import { localDays, localIsoDate, zonedTimeToUtc } from "./timezone";

/**
 * Availability slot computation (pure, fully timezone-aware).
 * Windows are defined as minutes-from-local-midnight in the schedule's
 * timezone; conversion through `zonedTimeToUtc` makes DST days (23h/25h)
 * come out correct by construction.
 */

export type WeeklyRule = { weekday: number; startMinute: number; endMinute: number };
export type DateOverride = {
  /** ISO `YYYY-MM-DD` in the schedule's timezone. */
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  isUnavailable: boolean;
};
export type BusyInterval = { startsAt: Date; endsAt: Date };

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function hasConflict(busy: BusyInterval[], start: Date, end: Date): boolean {
  return busy.some((b) => intervalsOverlap(start, end, b.startsAt, b.endsAt));
}

export type SlotParams = {
  timezone: string;
  rules: WeeklyRule[];
  overrides: DateOverride[];
  busy: BusyInterval[];
  from: Date;
  to: Date;
  now: Date;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  minNoticeMinutes?: number;
  maxWindowDays?: number;
  /** Slot grid step; defaults to the meeting duration. */
  stepMinutes?: number;
  maxSlots?: number;
};

/** Returns candidate slot start instants (UTC), sorted ascending. */
export function computeAvailableSlots(params: SlotParams): Date[] {
  const {
    timezone,
    rules,
    overrides,
    busy,
    now,
    durationMinutes,
    bufferBeforeMinutes = 0,
    bufferAfterMinutes = 0,
    minNoticeMinutes = 0,
    maxWindowDays = 365,
    maxSlots = 500,
  } = params;
  const step = params.stepMinutes ?? durationMinutes;
  if (durationMinutes <= 0 || step <= 0) return [];

  const earliest = new Date(
    Math.max(params.from.getTime(), now.getTime() + minNoticeMinutes * 60_000),
  );
  const latest = new Date(
    Math.min(params.to.getTime(), now.getTime() + maxWindowDays * 86_400_000),
  );
  if (earliest >= latest) return [];

  const overridesByDate = new Map<string, DateOverride[]>();
  for (const o of overrides) {
    const list = overridesByDate.get(o.date) ?? [];
    list.push(o);
    overridesByDate.set(o.date, list);
  }

  const slots: Date[] = [];

  for (const day of localDays(earliest, latest, timezone)) {
    const iso = localIsoDate(day.dayStartUtc, timezone);
    const dayOverrides = overridesByDate.get(iso);

    let windows: Array<{ startMinute: number; endMinute: number }>;
    if (dayOverrides?.some((o) => o.isUnavailable)) {
      windows = [];
    } else if (dayOverrides && dayOverrides.length > 0) {
      windows = dayOverrides
        .filter((o) => o.startMinute !== null && o.endMinute !== null)
        .map((o) => ({ startMinute: o.startMinute!, endMinute: o.endMinute! }));
    } else {
      windows = rules
        .filter((r) => r.weekday === day.weekday)
        .map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute }));
    }

    for (const w of windows) {
      if (w.endMinute - w.startMinute < durationMinutes) continue;
      for (let minute = w.startMinute; minute + durationMinutes <= w.endMinute; minute += step) {
        const start = zonedTimeToUtc(day.year, day.month, day.day, minute, timezone);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        if (start < earliest || end > latest) continue;
        const guardStart = new Date(start.getTime() - bufferBeforeMinutes * 60_000);
        const guardEnd = new Date(end.getTime() + bufferAfterMinutes * 60_000);
        if (hasConflict(busy, guardStart, guardEnd)) continue;
        slots.push(start);
        if (slots.length >= maxSlots) return slots;
      }
    }
  }

  return slots;
}
