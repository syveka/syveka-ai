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
export function busyIntervals(
  rows: BusyEventRow[],
  from: Date,
  to: Date,
  options: { complete?: boolean } = {},
): BusyInterval[] {
  // Rows that were never loaded (see `loadBusyRows`) can hide any event in
  // the window, so none of it can be offered as free.
  if (options.complete === false) return [{ startsAt: from, endsAt: to }];
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

/** The columns busy-time queries need (`id` pages them). */
export const BUSY_ROW_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  recurrenceRule: true,
  timezone: true,
} satisfies Prisma.CalendarEventSelect;

/** Newest first, with `id` as a stable tie-break for paging. */
export const BUSY_ROW_ORDER: Prisma.CalendarEventOrderByWithRelationInput[] = [
  { startsAt: "desc" },
  { id: "desc" },
];

export const BUSY_ROW_PAGE_SIZE = 500;
export const BUSY_ROW_MAX_PAGES = 10;

export type BusyRowPage = { take: number; skip?: number; cursor?: { id: string } };

/**
 * Loads every row a busy-time query matches, page by page (at most
 * BUSY_ROW_MAX_PAGES pages). The candidate set includes every recurring series
 * that ever started before the window, so a single capped query could leave
 * out an old series that still occupies the window and offer its time as free.
 * `complete: false` means rows were left unread: pass it to `busyIntervals`,
 * which then treats the whole window as busy.
 */
export async function loadBusyRows<Row extends BusyEventRow & { id: string }>(
  fetchPage: (page: BusyRowPage) => Promise<Row[]>,
): Promise<{ rows: Row[]; complete: boolean }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < BUSY_ROW_MAX_PAGES; page++) {
    const batch = await fetchPage(
      cursor
        ? { take: BUSY_ROW_PAGE_SIZE, skip: 1, cursor: { id: cursor } }
        : { take: BUSY_ROW_PAGE_SIZE },
    );
    rows.push(...batch);
    if (batch.length < BUSY_ROW_PAGE_SIZE) return { rows, complete: true };
    cursor = batch.at(-1)!.id;
  }
  const more = await fetchPage({ take: 1, skip: 1, cursor: { id: cursor! } });
  if (more.length > 0) {
    console.warn(JSON.stringify({ event: "calendar_busy_rows_incomplete", loaded: rows.length }));
  }
  return { rows, complete: more.length === 0 };
}
