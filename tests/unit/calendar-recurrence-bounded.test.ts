import { describe, expect, it } from "vitest";
import {
  expandOccurrences,
  expandOccurrencesWithStatus,
  MAX_EXPANSION_STEPS,
  validateRecurrenceRule,
} from "@/server/calendar/recurrence";
import { busyIntervals } from "@/server/calendar/busy";
import { toZonedWallTime } from "@/lib/date-time";

/**
 * Two expansion defects (overnight review, 2026-10-11):
 * A. Monthly COUNT consumed months that lack the day: Jan 31 with COUNT=3
 *    gave Jan 31 and Mar 31 only (expected Jan 31, Mar 31, May 31).
 * B. Expansion walked from the series origin and stopped after 500 steps, so
 *    a series older than 500 days/weeks/months returned nothing near today and
 *    its busy time showed as free on booking pages and in conflict checks.
 */

const HELSINKI = "Europe/Helsinki";
const DAY = 86_400_000;

type Range = [from: string, to: string];

function expand(
  start: string,
  end: string,
  rule: string,
  [from, to]: Range,
  timeZone: string | null = null,
  max?: number,
) {
  return expandOccurrencesWithStatus({
    seriesStart: new Date(start),
    seriesEnd: new Date(end),
    rule: validateRecurrenceRule(rule),
    rangeFrom: new Date(from),
    rangeTo: new Date(to),
    timeZone,
    max,
  });
}

const iso = (r: { occurrences: Array<{ startsAt: Date }> }) =>
  r.occurrences.map((o) => o.startsAt.toISOString());

/**
 * Reference expansion in UTC: walks every day from the series origin with no
 * caps, deciding membership directly from the rule. Slow but obviously right.
 */
function reference(start: string, end: string, ruleText: string, [from, to]: Range): string[] {
  const rule = validateRecurrenceRule(ruleText);
  const s = new Date(start);
  const duration = new Date(end).getTime() - s.getTime();
  const anchorSunday =
    Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - s.getUTCDay() * DAY;
  const days = rule.byDay?.length ? rule.byDay : [s.getUTCDay()];
  const out: string[] = [];
  let produced = 0;
  for (let t = s.getTime(); t < new Date(to).getTime(); t += DAY) {
    const d = new Date(t);
    const dayIndex = Math.round((t - s.getTime()) / DAY);
    let member: boolean;
    if (rule.freq === "DAILY") member = dayIndex % rule.interval === 0;
    else if (rule.freq === "WEEKLY") {
      const week = Math.floor(
        (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - anchorSunday) / (7 * DAY),
      );
      member = days.includes(d.getUTCDay()) && week % rule.interval === 0;
    } else {
      const months =
        (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + (d.getUTCMonth() - s.getUTCMonth());
      member = d.getUTCDate() === s.getUTCDate() && months % rule.interval === 0;
    }
    if (!member) continue;
    if (rule.count !== undefined && produced >= rule.count) break;
    if (rule.until && d > rule.until) break;
    produced += 1;
    if (t + duration > new Date(from).getTime()) out.push(d.toISOString());
  }
  return out;
}

describe("A. monthly COUNT counts real occurrences only", () => {
  it("the reported case: Jan 31 + COUNT=3 is Jan 31, Mar 31, May 31", () => {
    for (const zone of [null, HELSINKI]) {
      const r = expand(
        "2026-01-31T10:00:00Z",
        "2026-01-31T11:00:00Z",
        "FREQ=MONTHLY;COUNT=3",
        ["2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z"],
        zone,
      );
      expect(
        r.occurrences.map((o) => toZonedWallTime(o.startsAt, zone ?? "UTC").slice(0, 10)),
      ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
      expect(r.truncated).toBe(false);
    }
  });

  it("the 30th skips February; the 29th exists in February of leap years only", () => {
    expect(
      iso(
        expand("2026-01-30T10:00:00Z", "2026-01-30T11:00:00Z", "FREQ=MONTHLY;COUNT=3", [
          "2026-01-01T00:00:00Z",
          "2026-12-31T00:00:00Z",
        ]),
      ),
    ).toEqual(["2026-01-30T10:00:00.000Z", "2026-03-30T10:00:00.000Z", "2026-04-30T10:00:00.000Z"]);
    expect(
      iso(
        expand("2027-01-29T10:00:00Z", "2027-01-29T11:00:00Z", "FREQ=MONTHLY;COUNT=2", [
          "2027-01-01T00:00:00Z",
          "2027-12-31T00:00:00Z",
        ]),
      ),
    ).toEqual(["2027-01-29T10:00:00.000Z", "2027-03-29T10:00:00.000Z"]);
    expect(
      iso(
        expand("2028-01-29T10:00:00Z", "2028-01-29T11:00:00Z", "FREQ=MONTHLY;COUNT=2", [
          "2028-01-01T00:00:00Z",
          "2028-12-31T00:00:00Z",
        ]),
      ),
    ).toEqual(["2028-01-29T10:00:00.000Z", "2028-02-29T10:00:00.000Z"]);
  });

  it("Feb 29 every 12 months lands only in leap years (2100 is not one)", () => {
    expect(
      iso(
        expand("2096-02-29T10:00:00Z", "2096-02-29T11:00:00Z", "FREQ=MONTHLY;INTERVAL=12;COUNT=2", [
          "2096-01-01T00:00:00Z",
          "2110-01-01T00:00:00Z",
        ]),
      ),
    ).toEqual(["2096-02-29T10:00:00.000Z", "2104-02-29T10:00:00.000Z"]);
  });

  it("occurrences before the range still use up COUNT", () => {
    // Jan 31 and Mar 31 are before the range; the third is May 31.
    expect(
      iso(
        expand("2026-01-31T10:00:00Z", "2026-01-31T11:00:00Z", "FREQ=MONTHLY;COUNT=3", [
          "2026-04-01T00:00:00Z",
          "2026-12-31T00:00:00Z",
        ]),
      ),
    ).toEqual(["2026-05-31T10:00:00.000Z"]);
    // Daily: Oct 1 and 2 are before the range.
    expect(
      iso(
        expand("2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z", "FREQ=DAILY;COUNT=5", [
          "2026-10-03T00:00:00Z",
          "2026-10-31T00:00:00Z",
        ]),
      ),
    ).toEqual(["2026-10-03T10:00:00.000Z", "2026-10-04T10:00:00.000Z", "2026-10-05T10:00:00.000Z"]);
    // Weekly Mon+Wed from Mon Oct 5: Oct 5, 7, 12, 14, 19 — three before the range.
    expect(
      iso(
        expand("2026-10-05T10:00:00Z", "2026-10-05T11:00:00Z", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", [
          "2026-10-13T00:00:00Z",
          "2026-12-31T00:00:00Z",
        ]),
      ),
    ).toEqual(["2026-10-14T10:00:00.000Z", "2026-10-19T10:00:00.000Z"]);
  });

  it("a COUNT exhausted before the range yields nothing, and that is complete", () => {
    const r = expand("2020-01-06T10:00:00Z", "2020-01-06T11:00:00Z", "FREQ=WEEKLY;COUNT=10", [
      "2026-10-12T00:00:00Z",
      "2026-10-13T00:00:00Z",
    ]);
    expect(r).toEqual({ occurrences: [], truncated: false });
  });
});

describe("B. old series are expanded near the requested range, not from their origin", () => {
  const oct12: Range = ["2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z"];

  it("the reported case: daily since 2024-01-01 has its Oct 12, 2026 occurrence", () => {
    const r = expand("2024-01-01T10:00:00Z", "2024-01-01T11:00:00Z", "FREQ=DAILY", oct12);
    expect(r).toEqual({
      occurrences: [
        { startsAt: new Date("2026-10-12T10:00:00Z"), endsAt: new Date("2026-10-12T11:00:00Z") },
      ],
      truncated: false,
    });
  });

  it("weekly since 2014 and monthly since 1980 also reach Oct 2026", () => {
    expect(
      iso(expand("2014-01-06T10:00:00Z", "2014-01-06T11:00:00Z", "FREQ=WEEKLY", oct12)),
    ).toEqual(["2026-10-12T10:00:00.000Z"]);
    expect(
      iso(expand("1980-01-12T10:00:00Z", "1980-01-12T11:00:00Z", "FREQ=MONTHLY", oct12)),
    ).toEqual(["2026-10-12T10:00:00.000Z"]);
  });

  it("…with the event's zone, keeping local time (12:00 Helsinki in winter and summer)", () => {
    for (const [start, rule] of [
      ["2024-01-01T10:00:00Z", "FREQ=DAILY"],
      ["2014-01-06T10:00:00Z", "FREQ=WEEKLY"],
      ["1980-01-12T10:00:00Z", "FREQ=MONTHLY"],
    ] as const) {
      const end = new Date(new Date(start).getTime() + 3_600_000).toISOString();
      expect(iso(expand(start, end, rule, oct12, HELSINKI))).toEqual(["2026-10-12T09:00:00.000Z"]);
    }
  });

  it("a series 126 years old needs no walk from its origin (more days than the step budget)", () => {
    expect((Date.parse("2026-10-12") - Date.parse("1900-01-01")) / DAY).toBeGreaterThan(
      MAX_EXPANSION_STEPS,
    );
    const r = expand("1900-01-01T10:00:00Z", "1900-01-01T11:00:00Z", "FREQ=DAILY", oct12);
    expect(r).toEqual({
      occurrences: [
        { startsAt: new Date("2026-10-12T10:00:00Z"), endsAt: new Date("2026-10-12T11:00:00Z") },
      ],
      truncated: false,
    });
  });

  it("weekly every day since 1900 and monthly since the year 300 also exceed the budget from origin", () => {
    const weekly = expand(
      "1900-01-01T10:00:00Z",
      "1900-01-01T11:00:00Z",
      "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA",
      oct12,
    );
    expect(weekly).toEqual({
      occurrences: [
        { startsAt: new Date("2026-10-12T10:00:00Z"), endsAt: new Date("2026-10-12T11:00:00Z") },
      ],
      truncated: false,
    });
    expect((2026 - 300) * 12).toBeGreaterThan(MAX_EXPANSION_STEPS);
    expect(
      iso(expand("0300-01-12T10:00:00Z", "0300-01-12T11:00:00Z", "FREQ=MONTHLY", oct12)),
    ).toEqual(["2026-10-12T10:00:00.000Z"]);
  });

  it("intervals > 1 and BYDAY keep their phase far from the origin (checked against a full walk)", () => {
    const cases: Array<[string, string, string, Range]> = [
      [
        "2014-01-07T10:00:00Z",
        "2014-01-07T11:00:00Z",
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
        ["2026-09-28T00:00:00Z", "2026-11-09T00:00:00Z"],
      ],
      [
        "2014-01-08T10:00:00Z",
        "2014-01-08T11:00:00Z",
        "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,WE,SA",
        ["2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"],
      ],
      [
        "2015-03-10T10:00:00Z",
        "2015-03-10T11:00:00Z",
        "FREQ=DAILY;INTERVAL=3",
        ["2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z"],
      ],
      [
        "2000-01-31T10:00:00Z",
        "2000-01-31T11:00:00Z",
        "FREQ=MONTHLY;INTERVAL=5",
        ["2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"],
      ],
      [
        "2016-02-29T10:00:00Z",
        "2016-02-29T11:00:00Z",
        "FREQ=MONTHLY;INTERVAL=12",
        ["2023-01-01T00:00:00Z", "2033-01-01T00:00:00Z"],
      ],
      [
        "2026-01-31T10:00:00Z",
        "2026-01-31T11:00:00Z",
        "FREQ=MONTHLY;COUNT=7",
        ["2026-01-01T00:00:00Z", "2027-12-01T00:00:00Z"],
      ],
      [
        "2026-10-05T10:00:00Z",
        "2026-10-05T11:00:00Z",
        "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5",
        ["2026-10-13T00:00:00Z", "2026-12-31T00:00:00Z"],
      ],
      [
        "2026-10-01T10:00:00Z",
        "2026-10-01T11:00:00Z",
        "FREQ=DAILY;UNTIL=20261010T100000Z",
        ["2026-10-05T00:00:00Z", "2026-10-31T00:00:00Z"],
      ],
      // Starts on a Wednesday: the first week holds one occurrence, not two.
      [
        "2026-10-07T10:00:00Z",
        "2026-10-07T11:00:00Z",
        "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3",
        ["2026-10-13T00:00:00Z", "2026-12-31T00:00:00Z"],
      ],
      // 50-hour daily blocks: the two before the range still overlap it.
      [
        "2024-01-01T10:00:00Z",
        "2024-01-03T12:00:00Z",
        "FREQ=DAILY",
        ["2026-10-12T00:00:00Z", "2026-10-12T01:00:00Z"],
      ],
    ];
    for (const [start, end, rule, range] of cases) {
      const r = expand(start, end, rule, range, null, 500);
      expect(iso(r), `${rule} from ${start}`).toEqual(reference(start, end, rule, range));
      expect(r.truncated).toBe(false);
    }
  });
});

describe("range edges, UNTIL and the output cap", () => {
  it("UNTIL on an occurrence keeps it; one second earlier drops it", () => {
    const range: Range = ["2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z"];
    const s = "2026-10-05T10:00:00Z";
    const e = "2026-10-05T11:00:00Z";
    expect(iso(expand(s, e, "FREQ=WEEKLY;UNTIL=20261019T100000Z", range))).toEqual([
      "2026-10-05T10:00:00.000Z",
      "2026-10-12T10:00:00.000Z",
      "2026-10-19T10:00:00.000Z",
    ]);
    expect(iso(expand(s, e, "FREQ=WEEKLY;UNTIL=20261019T095959Z", range))).toEqual([
      "2026-10-05T10:00:00.000Z",
      "2026-10-12T10:00:00.000Z",
    ]);
  });

  it("an occurrence starting before the range but ending inside it is included; touching ones are not", () => {
    // Weekly 3-day block since 2014 (Mon 10:00 → Thu 10:00).
    const s = "2014-01-06T10:00:00Z";
    const e = "2014-01-09T10:00:00Z";
    expect(
      iso(expand(s, e, "FREQ=WEEKLY", ["2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"])),
    ).toEqual(["2026-10-12T10:00:00.000Z"]);
    // Ends exactly at rangeFrom / starts exactly at rangeTo: no overlap.
    expect(
      iso(expand(s, e, "FREQ=WEEKLY", ["2026-10-15T10:00:00Z", "2026-10-19T10:00:00Z"])),
    ).toEqual([]);
  });

  it("the output cap reports truncation only when more occurrences exist", () => {
    const range: Range = ["2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z"];
    const s = "2026-10-01T10:00:00Z";
    const e = "2026-10-01T11:00:00Z";
    const capped = expand(s, e, "FREQ=DAILY", range, null, 10);
    expect(capped.occurrences).toHaveLength(10);
    expect(capped.truncated).toBe(true);
    const exact = expand(s, e, "FREQ=DAILY", range, null, 30);
    expect(exact.occurrences).toHaveLength(30);
    expect(exact.truncated).toBe(false);
    const zoned = expand(s, e, "FREQ=DAILY", range, HELSINKI, 10);
    expect(zoned.occurrences).toHaveLength(10);
    expect(zoned.truncated).toBe(true);
  });

  it("expandOccurrences keeps returning the plain occurrence list", () => {
    expect(
      expandOccurrences({
        seriesStart: new Date("2024-01-01T10:00:00Z"),
        seriesEnd: new Date("2024-01-01T11:00:00Z"),
        rule: validateRecurrenceRule("FREQ=DAILY"),
        rangeFrom: new Date("2026-10-12T00:00:00Z"),
        rangeTo: new Date("2026-10-13T00:00:00Z"),
      }).map((o) => o.startsAt.toISOString()),
    ).toEqual(["2026-10-12T10:00:00.000Z"]);
  });
});

describe("busy time never shows an uncomputed occurrence as free", () => {
  it("an old daily series blocks its slot on Oct 12, 2026", () => {
    const busy = busyIntervals(
      [
        {
          startsAt: new Date("2024-01-01T10:00:00Z"),
          endsAt: new Date("2024-01-01T11:00:00Z"),
          recurrenceRule: "FREQ=DAILY",
          timezone: "UTC",
        },
      ],
      new Date("2026-10-12T00:00:00Z"),
      new Date("2026-10-13T00:00:00Z"),
    );
    expect(busy.map((b) => b.startsAt.toISOString())).toEqual(["2026-10-12T10:00:00.000Z"]);
  });

  it("past the output cap, the rest of the window counts as busy", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2028-01-01T00:00:00Z"); // 730 daily occurrences > 500 cap
    const busy = busyIntervals(
      [
        {
          startsAt: new Date("2026-01-01T10:00:00Z"),
          endsAt: new Date("2026-01-01T11:00:00Z"),
          recurrenceRule: "FREQ=DAILY",
          timezone: "UTC",
        },
      ],
      from,
      to,
    );
    const last = busy.at(-1)!;
    expect(busy).toHaveLength(501);
    expect(last.endsAt).toEqual(to);
    expect(last.startsAt.getTime()).toBeLessThanOrEqual(Date.parse("2027-05-16T10:00:00Z"));
  });
});
