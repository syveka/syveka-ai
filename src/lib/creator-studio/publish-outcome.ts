/**
 * FAILED codes whose post may already be live on the platform: a publish run
 * killed before it recorded the result (set by the stale sweep) and a publish
 * call that got no answer. No job publishes such a post again; its author
 * checks the platform and confirms it is not live before scheduling it again.
 * Shared by the publishing engine, the scheduling service and the calendar UI.
 */
export const UNKNOWN_PUBLISH_OUTCOME_CODES = ["publish_interrupted", "publish_outcome_unknown"];

export function isUnknownPublishOutcome(lastErrorCode: string | null | undefined): boolean {
  return lastErrorCode != null && UNKNOWN_PUBLISH_OUTCOME_CODES.includes(lastErrorCode);
}
