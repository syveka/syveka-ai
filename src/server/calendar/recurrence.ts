/**
 * Minimal RRULE (RFC 5545 subset) — parse, validate and expand.
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly).
 * Kept deliberately small: external-calendar recurrences sync as expanded
 * instances; this rule engine only powers internally created events.
 */

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

const HARD_OCCURRENCE_CAP = 500;

/**
 * Expand occurrences of a recurring event intersecting [rangeFrom, rangeTo).
 * Day stepping happens in UTC on the series start instant, which keeps the
 * event's wall-clock start stable for whole-day intervals.
 */
export function expandOccurrences(params: {
  seriesStart: Date;
  seriesEnd: Date;
  rule: RecurrenceRule;
  rangeFrom: Date;
  rangeTo: Date;
  max?: number;
}): Occurrence[] {
  const { seriesStart, seriesEnd, rule, rangeFrom, rangeTo } = params;
  const max = Math.min(params.max ?? 100, HARD_OCCURRENCE_CAP);
  const durationMs = seriesEnd.getTime() - seriesStart.getTime();
  const out: Occurrence[] = [];

  const pushIfInRange = (start: Date) => {
    if (rule.until && start > rule.until) return "stop" as const;
    const end = new Date(start.getTime() + durationMs);
    if (start < rangeTo && end > rangeFrom) out.push({ startsAt: start, endsAt: end });
    return start >= rangeTo ? ("stop" as const) : ("continue" as const);
  };

  if (rule.freq === "DAILY") {
    let produced = 0;
    for (let i = 0; produced < (rule.count ?? Infinity) && i < HARD_OCCURRENCE_CAP; i++) {
      const start = new Date(seriesStart.getTime() + i * rule.interval * 86_400_000);
      produced += 1;
      if (pushIfInRange(start) === "stop" || out.length >= max) break;
    }
  } else if (rule.freq === "WEEKLY") {
    const days = rule.byDay?.length ? [...rule.byDay].sort() : [seriesStart.getUTCDay()];
    let produced = 0;
    // Anchor at the Sunday of the series-start week (UTC).
    const weekAnchor = new Date(seriesStart.getTime() - seriesStart.getUTCDay() * 86_400_000);
    outer: for (let w = 0; w < HARD_OCCURRENCE_CAP; w++) {
      const weekStart = new Date(weekAnchor.getTime() + w * rule.interval * 7 * 86_400_000);
      for (const d of days) {
        const start = new Date(weekStart.getTime() + d * 86_400_000);
        if (start < seriesStart) continue;
        if (produced >= (rule.count ?? Infinity)) break outer;
        produced += 1;
        if (pushIfInRange(start) === "stop" || out.length >= max) break outer;
      }
    }
  } else {
    // MONTHLY: same day-of-month; months lacking the day (e.g. 31st) are skipped.
    const dayOfMonth = seriesStart.getUTCDate();
    let produced = 0;
    for (let m = 0; produced < (rule.count ?? Infinity) && m < HARD_OCCURRENCE_CAP; m++) {
      const base = new Date(seriesStart);
      const targetMonth = base.getUTCMonth() + m * rule.interval;
      const candidate = new Date(
        Date.UTC(
          base.getUTCFullYear(),
          targetMonth,
          dayOfMonth,
          base.getUTCHours(),
          base.getUTCMinutes(),
          base.getUTCSeconds(),
        ),
      );
      produced += 1;
      if (candidate.getUTCDate() !== dayOfMonth) continue; // rolled over: skip month
      if (pushIfInRange(candidate) === "stop" || out.length >= max) break;
    }
  }

  return out;
}
