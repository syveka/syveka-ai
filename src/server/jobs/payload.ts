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
 * QStash counts the retries so far in this header; without it (a manual or
 * test delivery) nothing is assumed to follow, so the attempt is the last.
 */
export function jobWillBeRetried(request: Request): boolean {
  const retried = request.headers.get("upstash-retried");
  return retried !== null && Number(retried) < JOB_MAX_RETRIES;
}
