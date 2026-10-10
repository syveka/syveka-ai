/**
 * Minimal RRULE (RFC 5545 subset) — parse, validate and expand.
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly).
 * Kept deliberately small: external-calendar recurrences sync as expanded
 * instances; this rule engine only powers internally created events.
 */

import { isValidTimeZone, toZonedWallTime, zonedWallTimeToUtc } from "@/lib/date-time";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export type RecurrenceRule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  count?: number;
  until?: Date;
  byDay?: number[]; // 0=Sunday … 6=Saturday
};

export class RecurrenceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_format"
      | "unsupported_freq"
      | "invalid_interval"
      | "invalid_count"
      | "invalid_until"
      | "invalid_byday"
      | "count_and_until",
  ) {
    super(message);
    this.name = "RecurrenceError";
  }
}

const MAX_INTERVAL = 52;
const MAX_COUNT = 365;

export function parseRecurrenceRule(rule: string): RecurrenceRule {
  const cleaned = rule.trim().replace(/^RRULE:/i, "");
  if (!cleaned) throw new RecurrenceError("Empty rule", "invalid_format");

  const parts = new Map<string, string>();
  for (const chunk of cleaned.split(";")) {
    if (!chunk) continue;
    const [key, value] = chunk.split("=");
    if (!key || value === undefined) throw new RecurrenceError("Malformed pair", "invalid_format");
    parts.set(key.toUpperCase(), value.toUpperCase());
  }

  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    throw new RecurrenceError(`Unsupported FREQ: ${freq ?? "missing"}`, "unsupported_freq");
  }

  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
    throw new RecurrenceError("INTERVAL out of range", "invalid_interval");
  }

  let count: number | undefined;
  if (parts.has("COUNT")) {
    count = Number(parts.get("COUNT"));
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      throw new RecurrenceError("COUNT out of range", "invalid_count");
    }
  }

  let until: Date | undefined;
  if (parts.has("UNTIL")) {
    const raw = parts.get("UNTIL")!;
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw);
    if (!m) throw new RecurrenceError("UNTIL must be YYYYMMDD[THHMMSSZ]", "invalid_until");
    until = new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] ?? 23),
        Number(m[5] ?? 59),
        Number(m[6] ?? 59),
      ),
    );
    if (Number.isNaN(until.getTime())) {
      throw new RecurrenceError("UNTIL is not a valid date", "invalid_until");
    }
  }

  if (count !== undefined && until !== undefined) {
    throw new RecurrenceError("COUNT and UNTIL are mutually exclusive", "count_and_until");
  }

  let byDay: number[] | undefined;
  if (parts.has("BYDAY")) {
    if (freq !== "WEEKLY")
      throw new RecurrenceError("BYDAY only with FREQ=WEEKLY", "invalid_byday");
    byDay = parts
      .get("BYDAY")!
      .split(",")
      .map((code) => {
        const idx = WEEKDAY_CODES.indexOf(code as (typeof WEEKDAY_CODES)[number]);
        if (idx === -1) throw new RecurrenceError(`Bad BYDAY: ${code}`, "invalid_byday");
        return idx;
      });
    if (byDay.length === 0) throw new RecurrenceError("Empty BYDAY", "invalid_byday");
  }

  return { freq, interval, count, until, byDay };
}

/** Validate without expanding; returns the parsed rule or throws RecurrenceError. */
export function validateRecurrenceRule(rule: string): RecurrenceRule {
  return parseRecurrenceRule(rule);
}

export type Occurrence = { startsAt: Date; endsAt: Date };

/**
 * `truncated`: the expansion stopped before covering the whole range (output
 * cap or step budget), so occurrences inside it may be missing. A caller that
 * computes busy time must treat the uncovered part as busy, never as free.
 */
export type Expansion = { occurrences: Occurrence[]; truncated: boolean };

/** Most occurrences one expansion returns. */
const HARD_OCCURRENCE_CAP = 500;
/**
 * Most candidate dates one expansion examines. Expansion starts at the range,
 * not at the series origin, so this does not depend on how old a series is;
 * only a monthly COUNT series (at most MAX_COUNT occurrences) walks from its
 * origin, well within it.
 */
export const MAX_EXPANSION_STEPS = 20_000;

type ExpandParams = {
  seriesStart: Date;
  seriesEnd: Date;
  rule: RecurrenceRule;
  rangeFrom: Date;
  rangeTo: Date;
  max?: number;
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Occurrences intersecting [rangeFrom, rangeTo); see `expandOccurrencesWithStatus`. */
export function expandOccurrences(
  params: ExpandParams & { timeZone?: string | null },
): Occurrence[] {
  return expandOccurrencesWithStatus(params).occurrences;
}

/**
 * Expand occurrences of a recurring event intersecting [rangeFrom, rangeTo),
 * including one that starts before the range and ends inside it.
 *
 * With `timeZone` (the event's own zone), days are stepped in that zone's
 * wall-clock time, so a weekly 14:00 Helsinki meeting stays at 14:00 across a
 * DST change and weekdays/days-of-month are the zone's. Without it (or with an
 * unknown zone) days are stepped in UTC, which drifts by the DST offset.
 */
export function expandOccurrencesWithStatus(
  params: ExpandParams & { timeZone?: string | null },
): Expansion {
  const { timeZone } = params;
  if (!timeZone || !isValidTimeZone(timeZone)) return expandInUtc(params);

  // Run the UTC algorithm on "naive" wall-clock instants (the zone's local
  // time written as if it were UTC), then map each back to a real instant.
  const subMinute = (d: Date) => ((d.getTime() % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  const toNaive = (d: Date) =>
    new Date(new Date(`${toZonedWallTime(d, timeZone)}:00Z`).getTime() + subMinute(d));
  const fromNaive = (d: Date) =>
    new Date(zonedWallTimeToUtc(d.toISOString().slice(0, 16), timeZone).getTime() + subMinute(d));

  const { seriesStart, seriesEnd, rule, rangeFrom, rangeTo } = params;
  const max = Math.min(params.max ?? 100, HARD_OCCURRENCE_CAP);
  const durationMs = seriesEnd.getTime() - seriesStart.getTime();
  const naiveStart = toNaive(seriesStart);
  // Zone offsets are under a day: widen the naive range by a day each side and
  // filter on real instants. UNTIL is a real instant too, so it is applied here.
  const naive = expandInUtc({
    seriesStart: naiveStart,
    seriesEnd: new Date(naiveStart.getTime() + durationMs),
    rule: { ...rule, until: undefined },
    rangeFrom: new Date(rangeFrom.getTime() - DAY_MS),
    rangeTo: new Date(rangeTo.getTime() + DAY_MS),
    max: HARD_OCCURRENCE_CAP,
  });

  const out: Occurrence[] = [];
  for (const occ of naive.occurrences) {
    // The first occurrence is the stored start itself: a wall time repeated by
    // a DST change (e.g. 03:30 on the autumn night) would otherwise map back to
    // the later of its two instants.
    const start =
      occ.startsAt.getTime() === naiveStart.getTime() ? seriesStart : fromNaive(occ.startsAt);
    if ((rule.until && start > rule.until) || start >= rangeTo) {
      return { occurrences: out, truncated: false };
    }
    const end = new Date(start.getTime() + durationMs);
    if (end > rangeFrom) {
      if (out.length >= max) return { occurrences: out, truncated: true };
      out.push({ startsAt: start, endsAt: end });
    }
  }
  return { occurrences: out, truncated: naive.truncated };
}

function expandInUtc(params: ExpandParams): Expansion {
  const { seriesStart, seriesEnd, rule, rangeFrom, rangeTo } = params;
  const max = Math.min(params.max ?? 100, HARD_OCCURRENCE_CAP);
  const durationMs = seriesEnd.getTime() - seriesStart.getTime();
  // An occurrence overlaps the range iff it starts before rangeTo and ends
  // after rangeFrom, i.e. starts after rangeFrom - duration.
  const earliestStart = rangeFrom.getTime() - durationMs;
  const budget = { steps: 0 };
  const out: Occurrence[] = [];

  for (const startMs of occurrenceStarts(seriesStart, rule, earliestStart, budget)) {
    if ((rule.until && startMs > rule.until.getTime()) || startMs >= rangeTo.getTime()) {
      return { occurrences: out, truncated: false };
    }
    const endMs = startMs + durationMs;
    if (endMs > rangeFrom.getTime()) {
      if (out.length >= max) return { occurrences: out, truncated: true };
      out.push({ startsAt: new Date(startMs), endsAt: new Date(endMs) });
    }
  }
  // The generator ends when COUNT is exhausted or the step budget runs out.
  return { occurrences: out, truncated: budget.steps > MAX_EXPANSION_STEPS };
}

/**
 * The series' occurrence starts (ms, ascending), honouring COUNT, beginning at
 * or shortly before `earliestStart` instead of at the series origin. COUNT
 * counts real occurrences only: a month without the day (e.g. the 31st) is
 * skipped without being counted.
 */
function* occurrenceStarts(
  seriesStart: Date,
  rule: RecurrenceRule,
  earliestStart: number,
  budget: { steps: number },
): Generator<number> {
  const origin = seriesStart.getTime();
  const count = rule.count ?? Infinity;
  const spend = () => ++budget.steps <= MAX_EXPANSION_STEPS;

  if (rule.freq === "DAILY") {
    // Occurrence k starts at origin + k * step and every k is an occurrence.
    const step = rule.interval * DAY_MS;
    for (let k = Math.max(0, Math.floor((earliestStart - origin) / step)); k < count; k++) {
      if (!spend()) return;
      yield origin + k * step;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const days = rule.byDay?.length
      ? [...new Set(rule.byDay)].sort((a, b) => a - b)
      : [seriesStart.getUTCDay()];
    const period = rule.interval * 7 * DAY_MS;
    // The Sunday of the series' first week, at the series' time of day.
    const anchor = origin - seriesStart.getUTCDay() * DAY_MS;
    const inFirstWeek = days.filter((d) => anchor + d * DAY_MS >= origin).length;
    // Week w's occurrences all start before week w + 1 begins, so weeks that
    // end before earliestStart are skipped; their occurrences are still counted.
    const firstWeek = Math.max(0, Math.floor((earliestStart - anchor) / period));
    let produced = firstWeek === 0 ? 0 : inFirstWeek + (firstWeek - 1) * days.length;
    for (let w = firstWeek; ; w++) {
      for (const d of days) {
        const start = anchor + w * period + d * DAY_MS;
        if (start < origin) continue;
        if (produced >= count || !spend()) return;
        produced += 1;
        yield start;
      }
    }
  }

  // MONTHLY: the series' day of month; months lacking it are skipped.
  const year = seriesStart.getUTCFullYear();
  const month = seriesStart.getUTCMonth();
  const dayOfMonth = seriesStart.getUTCDate();
  const timeOfDay = origin - Date.UTC(year, month, dayOfMonth);
  let firstIndex = 0;
  if (rule.count === undefined) {
    // Without COUNT nothing before the range needs counting: jump to it.
    const target = new Date(earliestStart);
    const monthsAhead = (target.getUTCFullYear() - year) * 12 + (target.getUTCMonth() - month);
    firstIndex = Math.max(0, Math.floor(monthsAhead / rule.interval) - 1);
  }
  let produced = 0;
  for (let i = firstIndex; produced < count; i++) {
    if (!spend()) return;
    const day = Date.UTC(year, month + i * rule.interval, dayOfMonth);
    if (new Date(day).getUTCDate() !== dayOfMonth) continue; // rolled over: skip month
    produced += 1;
    yield day + timeOfDay;
  }
}
