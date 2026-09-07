import type { Provider } from "../types.js";
import type { EvidenceItem, ProviderResult } from "../../schemas/index.js";
import {
  callSummaryInputSchema,
  callSummaryOutputSchema,
  callSummaryExecutionMetaSchema,
  type CallSummaryResult,
} from "../../schemas/call-summary.js";
import {
  buildSummarySentence,
  computeConfidence,
  detectCallerIntent,
  detectLanguage,
  detectRiskFlags,
  extractPoints,
} from "./heuristics.js";

export const CALL_SUMMARY_SKILL_ID = "voice-pilot/call-summary" as const;
export const CALL_SUMMARY_SKILL_VERSION = "1.0.0" as const;

/**
 * Reference provider for the "voice-pilot/call-summary" Skill: a real,
 * first-party, offline, no-network implementation of
 * `Skill -> Contract -> Policy -> Runtime -> Provider -> Evaluation ->
 * Audit` (see docs/call-summary-skill.md), following the same pattern as
 * providers/local-test-runner and providers/git-diff - genuinely computes
 * a result, never a stub.
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION: this file contains no Claude-specific
 * (or any other vendor-specific) API calls. The Skill's business logic -
 * schema validation, tenant enforcement, evidence/audit shape - lives here
 * and in providers/call-summary/heuristics.ts, entirely independent of
 * which analysis engine eventually powers it. A second provider (e.g. an
 * LLM-backed one) only has to satisfy the same `Provider` interface and
 * the same input/output contract - see providers/call-summary/mock-provider.ts
 * for a second, deliberately different implementation proving exactly
 * that swap requires no change here.
 *
 * SECURITY (see CLAUDE.md §4 and docs/call-summary-skill.md "Security"):
 *  - tenant_id must come from `input.tenant_id` only - the transcript body
 *    is never inspected for a tenant/org identifier, so a spoofed one
 *    inside transcript text has no effect on tenant scoping.
 *  - missing/invalid input fails closed: FAILURE, never a partial or
 *    best-guess result.
 *  - the produced output is validated against `callSummaryOutputSchema`
 *    before being returned as SUCCESS - "the algorithm ran" is never
 *    treated as equivalent to "the contract was satisfied".
 *  - evidence/audit-visible fields (message, evidence[].data) never
 *    contain raw transcript text or caller-identifying content - only
 *    operational metadata (counts, flags, tenant reference, timing).
 */
export function createCallSummaryProvider(): Provider {
  return {
    id: "voice-pilot-call-summary",
    isAvailable: () => true,
    async execute(rawInput: Record<string, unknown>): Promise<ProviderResult> {
      const startedAt = new Date();

      const parsedInput = callSummaryInputSchema.safeParse(
        (rawInput as { context?: unknown }).context ?? rawInput,
      );

      if (!parsedInput.success) {
        const missingTenant = parsedInput.error.issues.some((i) => i.path[0] === "tenant_id");
        return failure({
          startedAt,
          tenantRef: "unknown",
          errorClassification: missingTenant ? "tenant_context_missing" : "validation_error",
          message: missingTenant
            ? "call-summary rejected: tenant context is missing or empty - failing closed"
            : "call-summary rejected: input failed schema validation",
        });
      }

      const input = parsedInput.data;

      try {
        const { language, mixed } = detectLanguage(input.transcript, input.language_hint);
        const riskFlags = detectRiskFlags(input.transcript);
        const intent = detectCallerIntent(input.transcript);
        const { keyPoints, actionItems } = extractPoints(input.transcript);
        const confidence = computeConfidence({
          turnCount: input.transcript.length,
          mixedLanguage: mixed,
        });

        const output = callSummaryOutputSchema.parse({
          summary: buildSummarySentence({
            intent,
            turnCount: input.transcript.length,
            actionItemCount: actionItems.length,
          }),
          caller_intent: intent,
          key_points: keyPoints,
          action_items: actionItems,
          follow_up_required: actionItems.length > 0,
          risk_flags: riskFlags,
          language,
          confidence,
        });

        const endedAt = new Date();
        const meta = callSummaryExecutionMetaSchema.parse({
          skill: CALL_SUMMARY_SKILL_ID,
          skill_version: CALL_SUMMARY_SKILL_VERSION,
          tenant_ref: input.tenant_id,
          provider: "voice-pilot-call-summary",
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
              "call-summary output validated against callSummaryOutputSchema (zod, strict)",
            data: `PASS: 8/8 contract fields present and typed; risk_flags=[${riskFlags.join(",")}]`,
            timestamp: endedAt.toISOString(),
          },
        ];

        return {
          status: "SUCCESS",
          message:
            `voice-pilot/call-summary: analyzed ${input.transcript.length} transcript turn(s) ` +
            `for tenant=${input.tenant_id}; intent=${intent}; language=${language}; ` +
            `risk_flags=${riskFlags.length ? riskFlags.join(",") : "none"}; confidence=${confidence}`,
          evidence,
          data: result,
        };
      } catch {
        // Never leak internal exception details (message/stack may reflect
        // implementation internals) - a generic, sanitized failure only.
        return failure({
          startedAt,
          tenantRef: input.tenant_id,
          errorClassification: "internal_error",
          message: "call-summary failed: unexpected internal error during analysis",
        });
      }
    },
  };
}

function failure(params: {
  startedAt: Date;
  tenantRef: string;
  errorClassification: "validation_error" | "tenant_context_missing" | "internal_error";
  message: string;
}): ProviderResult {
  const endedAt = new Date();
  const meta = callSummaryExecutionMetaSchema.parse({
    skill: CALL_SUMMARY_SKILL_ID,
    skill_version: CALL_SUMMARY_SKILL_VERSION,
    tenant_ref: params.tenantRef,
    provider: "voice-pilot-call-summary",
    started_at: params.startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - params.startedAt.getTime(),
    status: "failure",
    error_classification: params.errorClassification,
  });
  return {
    status: "FAILURE",
    message: params.message,
    evidence: [],
    data: { meta },
  };
}
