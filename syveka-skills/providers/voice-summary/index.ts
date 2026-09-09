import { createUnavailableStubProvider } from "../unavailable-stub.js";

export const VOICE_SUMMARY_CAPABILITY = "voice.summarize";

/**
 * Voice Call Summary (capability `voice.summarize`) - honestly unavailable,
 * same shape as composio/perplexity/shadcn-mcp above: no live LLM call
 * wired up in this Skill yet. The root app's own production call-summary
 * pipeline (src/app/api/v1/jobs/post-call/route.ts) already calls Anthropic
 * directly and is NOT routed through this Skill - building that live
 * connection here is explicitly out of scope for this milestone (see
 * docs/skills/voice-call-summary.md's "What remains before promotion").
 *
 * `providers/voice-summary/deterministic-test-provider.ts` (test-only,
 * never exported from this file, never registered in any real providerMap)
 * is what evals/voice-call-summary.test.ts uses to prove the rest of the
 * Skill's contract - schema validation, permission evaluation, evidence,
 * verification, and audit - end-to-end without a live/paid call, per this
 * milestone's explicit "no new external integration" instruction.
 */
export const voiceSummaryProvider = createUnavailableStubProvider({
  id: "voice-summary",
  reason:
    "voice.summarize has no live provider connection in this milestone - no LLM call is wired " +
    "up, no API key provisioned. See docs/skills/voice-call-summary.md for the Skill contract, " +
    "the deterministic-test-provider used for local evals, and what a real connection would " +
    "require before this can move past REVIEW/REFERENCE.",
});
