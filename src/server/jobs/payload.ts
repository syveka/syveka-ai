import "server-only";

/**
 * The JSON of a verified job body, or `undefined` when the body isn't JSON.
 *
 * Every job route validates the result with its payload schema, which refuses
 * `undefined` as an invalid payload (400, no retry). Parsing with a bare
 * `JSON.parse` instead threw, which QStash took as a failure to retry three
 * times before parking the message in its dead-letter queue, for a body that
 * could never become valid. Only an operator-forged message reaches this
 * (`enqueue` always publishes JSON), so the cost was wasted retries and DLQ
 * noise rather than lost work.
 */
export function jobPayloadJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * How many times QStash delivers a job again after a non-2xx answer, so a
 * message is delivered at most JOB_MAX_RETRIES + 1 times (see enqueue).
 */
export const JOB_MAX_RETRIES = 3;

/**
 * Whether QStash will deliver this message again after a non-2xx answer.
 *
 * Upstash documents the header as `Upstash-Retried`: "How often the message
 * has been retried so far. Starts with 0."
 * (https://upstash.com/docs/qstash/howto/receiving), and its retry page shows
 * "Upstash-Retried: 0 // This is the first attempt"
 * (https://upstash.com/docs/qstash/features/retry). So with
 * `retries: JOB_MAX_RETRIES` the deliveries carry 0..JOB_MAX_RETRIES, and the
 * one carrying JOB_MAX_RETRIES is the last. Those pages don't say what a
 * dead-letter-queue replay or a schedule's delivery carries.
 *
 * Only a plain non-negative integer counts. Without the header (a manual or
 * test delivery), or with any other value (empty, signed, decimal, text),
 * nothing is assumed to follow, so the attempt is treated as the last.
 */
export function jobWillBeRetried(request: Request): boolean {
  const retried = request.headers.get("upstash-retried");
  if (retried === null || !/^\d+$/.test(retried)) return false;
  return Number(retried) < JOB_MAX_RETRIES;
}
