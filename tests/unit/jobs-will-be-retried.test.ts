import { describe, expect, it } from "vitest";
import { JOB_MAX_RETRIES, jobWillBeRetried } from "@/server/jobs/payload";

/**
 * QStash's `Upstash-Retried` header starts at 0 on the first delivery, so with
 * `retries: 3` a message is delivered with 0, 1, 2 and 3; the last one must not be
 * answered as if another delivery followed. Anything that isn't a plain non-negative
 * integer is read as "nothing follows" (fail towards telling the owner, not towards
 * waiting for a delivery that may never come).
 */
describe("jobWillBeRetried", () => {
  const delivery = (retried?: string) =>
    new Request("https://jobs.test/api/v1/jobs", {
      method: "POST",
      headers: retried === undefined ? {} : { "upstash-retried": retried },
    });
  // The value exactly as given: `Headers` trims surrounding whitespace itself.
  const rawHeader = (value: string | null) =>
    ({ headers: { get: () => value } }) as unknown as Request;

  it("the retry budget is three, so there are four deliveries", () => {
    expect(JOB_MAX_RETRIES).toBe(3);
  });

  it.each([
    ["0", true],
    ["1", true],
    ["2", true],
    ["3", false],
    ["4", false],
  ])("retried %s: another delivery follows = %s", (retried, expected) => {
    expect(jobWillBeRetried(delivery(retried))).toBe(expected);
  });

  it("no header (a manual or test delivery): nothing follows", () => {
    expect(jobWillBeRetried(delivery())).toBe(false);
    expect(jobWillBeRetried(rawHeader(null))).toBe(false);
  });

  it.each(["", "abc", "-1", "1.5", " 2 ", "+1", "1e0", "0x1", "2,0"])(
    "%j is not a retry count: nothing follows",
    (value) => {
      expect(jobWillBeRetried(rawHeader(value))).toBe(false);
    },
  );

  it.each(["", "abc", "-1", "1.5"])("%j sent as a real header: nothing follows", (value) => {
    expect(jobWillBeRetried(delivery(value))).toBe(false);
  });

  it("a count far past the budget is the last delivery, not an overflow", () => {
    expect(jobWillBeRetried(rawHeader("99999999999999999999999"))).toBe(false);
  });
});
