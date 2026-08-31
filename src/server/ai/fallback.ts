import "server-only";

import { isTransientAiError } from "@/server/ai/retry";
import { fallbackModel, type ModelChoice } from "@/server/ai/router";

/**
 * Opt-in cross-provider failover (§15.2 in the model router's own doc comment
 * describes this intent; nothing wired it in before this). A call site
 * chooses to adopt this wrapper — nothing calls it automatically, and no
 * existing call site's behavior changes by this file existing.
 *
 * Only a transient-looking failure (rate limit, timeout, 5xx — see
 * `isTransientAiError`) triggers `onFallback`; a non-transient error (bad
 * input, auth failure) propagates immediately, since switching provider
 * would not fix a malformed request.
 */
export async function withModelFallback<T>(
  primary: () => Promise<T>,
  onFallback: (fallback: ModelChoice) => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!isTransientAiError(error)) throw error;
    return onFallback(fallbackModel());
  }
}
