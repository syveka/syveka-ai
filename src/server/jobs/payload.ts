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
