import type { Provider } from "../types.js";
import type { EvidenceItem, ProviderResult } from "../../schemas/index.js";
import {
  callSummaryInputSchema,
  callSummaryOutputSchema,
  callSummaryExecutionMetaSchema,
  type CallSummaryResult,
} from "../../schemas/call-summary.js";
import { CALL_SUMMARY_SKILL_ID, CALL_SUMMARY_SKILL_VERSION } from "./index.js";

/**
 * A second, deliberately different implementation of the SAME
 * "voice-pilot/call-summary" Provider interface and contract, used ONLY by
 * evals/call-summary-provider-portability.test.ts to prove capability #6
 * of the platform proof brief: "replacing one provider with another does
 * not require modifying the Skill's business logic."
 *
 * This stands in for a future real second provider (e.g. an LLM-backed
 * one) without integrating a new paid API - per the brief's explicit
 * guidance to use a mock/fake adapter for this proof rather than wiring a
 * real paid dependency the platform proof doesn't need. It still validates
 * input/output against the exact same schemas as the reference provider
 * (providers/call-summary/index.ts) - a provider is never exempt from the
 * contract just because it's a test double; see docs/call-summary-skill.md
 * "Provider portability".
 */
export function createMockCallSummaryProvider(): Provider {
  return {
    id: "voice-pilot-call-summary-mock",
    isAvailable: () => true,
    async execute(rawInput: Record<string, unknown>): Promise<ProviderResult> {
      const startedAt = new Date();
      const parsed = callSummaryInputSchema.safeParse(
        (rawInput as { context?: unknown }).context ?? rawInput,
      );

      if (!parsed.success) {
        return {
          status: "FAILURE",
          message: "call-summary (mock provider) rejected: input failed schema validation",
          evidence: [],
        };
      }

      const input = parsed.data;
      const output = callSummaryOutputSchema.parse({
        summary: `[mock provider] Fixed canned summary for call ${input.call_id}.`,
        caller_intent: "general_inquiry",
        key_points: ["mock key point"],
        action_items: [],
        follow_up_required: false,
        risk_flags: [],
        language: input.language_hint ?? "en",
        confidence: 0.5,
      });

      const endedAt = new Date();
      const meta = callSummaryExecutionMetaSchema.parse({
        skill: CALL_SUMMARY_SKILL_ID,
        skill_version: CALL_SUMMARY_SKILL_VERSION,
        tenant_ref: input.tenant_id,
        provider: "voice-pilot-call-summary-mock",
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_ms: endedAt.getTime() - startedAt.getTime(),
        status: "success",
        error_classification: "none",
      });

      const result: CallSummaryResult = { output, meta };
      const evidence: EvidenceItem[] = [
        {
          type: "test",
          description:
            "call-summary (mock provider) output validated against callSummaryOutputSchema",
          data: "PASS: 8/8 contract fields present and typed (mock provider)",
          timestamp: endedAt.toISOString(),
        },
      ];

      return {
        status: "SUCCESS",
        message: `voice-pilot/call-summary (mock provider): fixed response for tenant=${input.tenant_id}`,
        evidence,
        data: result,
      };
    },
  };
}
