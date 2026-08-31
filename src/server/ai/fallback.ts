import "server-only";

import { isTransientAiError } from "@/server/ai/retry";
import { fallbackModel, type ModelChoice } from "@/server/ai/router";

/**
 * Opt-in control-flow scaffolding toward cross-provider failover (§15.2 in
 * the model router's own doc comment describes this intent; nothing wired
 * it in before this file existed). This is NOT itself working failover: it
 * only decides whether to call `onFallback` — the caller still has to
 * supply a real alternate execution path (e.g. an actual OpenAI
 * chat-completion call), which does not exist anywhere in this codebase
 * yet (`src/server/integrations/openai.ts` only wraps embeddings and
 * moderation today). No production call site imports this function as of
 * this commit — see docs/skills/model-routing.md.
 *
 * Only a transient-looking failure (rate limit, timeout, 5xx — see
 * `isTransientAiError`) triggers `onFallback`; a non-transient error (bad
 * input, auth failure, or a 404/model-not-found — NOT currently classified
 * as transient) propagates immediately instead.
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
