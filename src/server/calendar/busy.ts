import type { Prisma } from "@/generated/prisma/client/client";
import { expandOccurrencesWithStatus, validateRecurrenceRule } from "./recurrence";
import type { BusyInterval } from "./slots";

export type BusyEventRow = {
  startsAt: Date;
  endsAt: Date;
  recurrenceRule?: string | null;
  /** The event's own zone: a series keeps its wall-clock time across DST. */
  timezone?: string | null;
};

/**
 * The events that can occupy part of [from, to): one-off events overlapping
 * it, and recurring series that started before it ends. A series is stored
 * once (its first occurrence), so matching it by its own dates would miss
 * every later occurrence; expand the rows with `busyIntervals`.
 */
export function busyWindowWhere(from: Date, to: Date): Prisma.CalendarEventWhereInput {
  return {
    OR: [
      { recurrenceRule: null, startsAt: { lt: to }, endsAt: { gt: from } },
      { recurrenceRule: { not: null }, startsAt: { lt: to } },
    ],
  };
}

/** Recurring series that can have an occurrence before `to` (pair with `busyIntervals`). */
export function recurringSeriesWhere(to: Date): Prisma.CalendarEventWhereInput {
  return { recurrenceRule: { not: null }, startsAt: { lt: to } };
}

/**
 * Busy intervals within [from, to): one-off events as they are, and each
 * recurring series' occurrences there. A series whose rule can't be parsed
 * counts as its first occurrence only, as in `findConflicts`. If a series'
 * expansion is cut short, the rest of the window counts as busy: an occurrence
 * that was never computed must not be offered as free time.
 */
export function busyIntervals(rows: BusyEventRow[], from: Date, to: Date): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const row of rows) {
    if (!row.recurrenceRule) {
      out.push({ startsAt: row.startsAt, endsAt: row.endsAt });
      continue;
    }
    let rule;
    try {
      rule = validateRecurrenceRule(row.recurrenceRule);
    } catch {
      if (row.startsAt < to && row.endsAt > from) {
        out.push({ startsAt: row.startsAt, endsAt: row.endsAt });
      }
      continue;
    }
    const { occurrences, truncated } = expandOccurrencesWithStatus({
      seriesStart: row.startsAt,
      seriesEnd: row.endsAt,
      rule,
      rangeFrom: from,
      rangeTo: to,
      max: 500,
      timeZone: row.timezone,
    });
    out.push(...occurrences);
    if (truncated) {
      out.push({ startsAt: occurrences.at(-1)?.startsAt ?? from, endsAt: to });
    }
  }
  return out;
}
