import { describe, expect, it } from "vitest";
import { expandOccurrences, validateRecurrenceRule } from "@/server/calendar/recurrence";
import { busyIntervals } from "@/server/calendar/busy";
import { toZonedWallTime } from "@/lib/date-time";

/**
 * Overnight staging audit, 2026-10-11: a weekly Monday 14:00 Helsinki series
 * showed at 13:00 from Oct 26 (the EU DST change is Oct 25, 2026) because
 * occurrences were stepped in fixed UTC days. In the calendar, booking pages
 * and the AI tools every recurring event moved by an hour twice a year.
 * Occurrences are now stepped in the event's own zone.
 */

const HELSINKI = "Europe/Helsinki";

function expand(
  seriesStart: string,
  seriesEnd: string,
  rule: string,
  from: string,
  to: string,
  timeZone: string | null = HELSINKI,
  max?: number,
) {
  return expandOccurrences({
    seriesStart: new Date(seriesStart),
    seriesEnd: new Date(seriesEnd),
    rule: validateRecurrenceRule(rule),
    rangeFrom: new Date(from),
    rangeTo: new Date(to),
    timeZone,
    max,
  });
}

const local = (occ: Array<{ startsAt: Date }>, zone = HELSINKI) =>
  occ.map((o) => toZonedWallTime(o.startsAt, zone));

describe("recurring series keep their wall-clock time across DST", () => {
  it("the staging case: weekly Monday 14:00 Helsinki stays 14:00 after Oct 25", () => {
    const occ = expand(
      "2026-10-12T11:00:00Z", // 14:00 EEST
      "2026-10-12T12:00:00Z",
      "FREQ=WEEKLY",
      "2026-10-01T00:00:00Z",
      "2026-11-10T00:00:00Z",
    );
    expect(local(occ)).toEqual([
      "2026-10-12T14:00",
      "2026-10-19T14:00",
      "2026-10-26T14:00",
      "2026-11-02T14:00",
      "2026-11-09T14:00",
    ]);
    expect(occ[2]?.startsAt.toISOString()).toBe("2026-10-26T12:00:00.000Z"); // 14:00 EET
    expect(occ.every((o) => o.endsAt.getTime() - o.startsAt.getTime() === 3_600_000)).toBe(true);
  });

  it("spring forward: weekly Monday 09:00 stays 09:00 after Mar 29", () => {
    const occ = expand(
      "2026-03-16T07:00:00Z", // 09:00 EET
      "2026-03-16T07:30:00Z",
      "FREQ=WEEKLY",
      "2026-03-16T00:00:00Z",
      "2026-04-07T00:00:00Z",
    );
    expect(local(occ)).toEqual([
      "2026-03-16T09:00",
      "2026-03-23T09:00",
      "2026-03-30T09:00",
      "2026-04-06T09:00",
    ]);
  });

  it("daily across the change keeps 08:00 every day", () => {
    const occ = expand(
      "2026-10-23T05:00:00Z",
      "2026-10-23T05:15:00Z",
      "FREQ=DAILY",
      "2026-10-23T00:00:00Z",
      "2026-10-28T00:00:00Z",
    );
    expect(local(occ)).toEqual([
      "2026-10-23T08:00",
      "2026-10-24T08:00",
      "2026-10-25T08:00",
      "2026-10-26T08:00",
      "2026-10-27T08:00",
    ]);
  });

  it("biweekly and monthly keep their local time too", () => {
    expect(
      local(
        expand(
          "2026-10-12T11:00:00Z",
          "2026-10-12T12:00:00Z",
          "FREQ=WEEKLY;INTERVAL=2",
          "2026-10-01T00:00:00Z",
          "2026-11-10T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-10-12T14:00", "2026-10-26T14:00", "2026-11-09T14:00"]);
    expect(
      local(
        expand(
          "2026-09-15T07:00:00Z", // 10:00 EEST
          "2026-09-15T08:00:00Z",
          "FREQ=MONTHLY",
          "2026-09-01T00:00:00Z",
          "2026-12-31T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-09-15T10:00", "2026-10-15T10:00", "2026-11-15T10:00", "2026-12-15T10:00"]);
  });

  it("BYDAY uses the zone's weekday: Monday 01:00 Helsinki is Sunday in UTC", () => {
    const occ = expand(
      "2026-10-11T22:00:00Z", // Mon 2026-10-12 01:00 EEST
      "2026-10-11T23:00:00Z",
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-10-01T00:00:00Z",
      "2026-11-03T00:00:00Z",
    );
    expect(local(occ)).toEqual([
      "2026-10-12T01:00",
      "2026-10-19T01:00",
      "2026-10-26T01:00",
      "2026-11-02T01:00",
    ]);
  });

  it("COUNT counts occurrences, and UNTIL is a real instant", () => {
    expect(
      local(
        expand(
          "2026-10-12T11:00:00Z",
          "2026-10-12T12:00:00Z",
          "FREQ=WEEKLY;COUNT=3",
          "2026-10-01T00:00:00Z",
          "2026-12-01T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-10-12T14:00", "2026-10-19T14:00", "2026-10-26T14:00"]);
    // UNTIL just before Oct 26 14:00 EET (12:00Z): that occurrence is excluded.
    expect(
      local(
        expand(
          "2026-10-12T11:00:00Z",
          "2026-10-12T12:00:00Z",
          "FREQ=WEEKLY;UNTIL=20261026T115959Z",
          "2026-10-01T00:00:00Z",
          "2026-12-01T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-10-12T14:00", "2026-10-19T14:00"]);
  });

  it("only occurrences overlapping the range are returned, up to max", () => {
    const occ = expand(
      "2026-10-12T11:00:00Z",
      "2026-10-12T12:00:00Z",
      "FREQ=WEEKLY",
      "2026-10-26T12:30:00Z", // inside Oct 26's occurrence
      "2026-11-03T00:00:00Z",
    );
    expect(local(occ)).toEqual(["2026-10-26T14:00", "2026-11-02T14:00"]);
    expect(
      expand(
        "2026-10-12T11:00:00Z",
        "2026-10-12T12:00:00Z",
        "FREQ=WEEKLY",
        "2026-10-01T00:00:00Z",
        "2026-12-31T00:00:00Z",
        HELSINKI,
        2,
      ),
    ).toHaveLength(2);
  });

  it("keeps seconds of the series start", () => {
    const occ = expand(
      "2026-10-12T11:00:30Z",
      "2026-10-12T12:00:30Z",
      "FREQ=WEEKLY",
      "2026-10-20T00:00:00Z",
      "2026-10-27T00:00:00Z",
    );
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-26T12:00:30.000Z"]);
  });

  // Helsinki, Oct 25 2026: 04:00 EEST falls back to 03:00 EET, so 03:00–03:59
  // happens twice (00:00–00:59Z, then 01:00–01:59Z).
  it("ambiguous time: a series stored at the first 03:30 keeps that instant", () => {
    const occ = expand(
      "2026-10-25T00:30:00Z", // 03:30 EEST, the first of the two 03:30s
      "2026-10-25T01:00:00Z",
      "FREQ=DAILY",
      "2026-10-24T00:00:00Z",
      "2026-10-27T00:00:00Z",
    );
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z", // 03:30 EET
    ]);
  });

  it("ambiguous time: a later occurrence on the repeated hour takes the later instant (editor policy)", () => {
    const occ = expand(
      "2026-10-23T00:30:00Z", // 03:30 EEST
      "2026-10-23T01:00:00Z",
      "FREQ=DAILY",
      "2026-10-25T00:00:00Z",
      "2026-10-26T00:00:00Z",
    );
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-25T01:30:00.000Z"]);
  });

  // Helsinki, Mar 29 2026: 03:00 EET jumps to 04:00 EEST, so 03:00–03:59 never happens.
  it("nonexistent time: the skipped 03:30 moves forward to 04:30, keeping the duration", () => {
    const occ = expand(
      "2026-03-27T01:30:00Z", // 03:30 EET
      "2026-03-27T02:00:00Z",
      "FREQ=DAILY",
      "2026-03-28T00:00:00Z",
      "2026-03-31T00:00:00Z",
    );
    expect(local(occ)).toEqual(["2026-03-28T03:30", "2026-03-29T04:30", "2026-03-30T03:30"]);
    expect(occ.every((o) => o.endsAt.getTime() - o.startsAt.getTime() === 1_800_000)).toBe(true);
  });

  it("without a zone (or an unknown one) expansion is unchanged: fixed UTC steps", () => {
    for (const zone of [null, "Not/AZone"]) {
      const occ = expand(
        "2026-10-12T11:00:00Z",
        "2026-10-12T12:00:00Z",
        "FREQ=WEEKLY",
        "2026-10-20T00:00:00Z",
        "2026-10-27T00:00:00Z",
        zone,
      );
      expect(occ.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-26T11:00:00.000Z"]);
    }
  });
});

describe("busy time follows the event's zone", () => {
  it("a weekly 14:00 Helsinki series is busy at 14:00 local after the DST change", () => {
    const busy = busyIntervals(
      [
        {
          startsAt: new Date("2026-10-12T11:00:00Z"),
          endsAt: new Date("2026-10-12T12:00:00Z"),
          recurrenceRule: "FREQ=WEEKLY",
          timezone: HELSINKI,
        },
      ],
      new Date("2026-10-26T00:00:00Z"),
      new Date("2026-10-27T00:00:00Z"),
    );
    expect(busy.map((b) => b.startsAt.toISOString())).toEqual(["2026-10-26T12:00:00.000Z"]);
  });
});
