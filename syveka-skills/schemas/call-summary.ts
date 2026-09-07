import { z } from "zod";

/**
 * Contract for the "voice-pilot/call-summary" Skill - the first
 * production-shaped Skill built on top of the Syveka Master Skill
 * architecture (see docs/call-summary-skill.md). Every layer (provider,
 * orchestrator caller, eval) validates against these schemas; nothing gets
 * to skip validation by claiming to be "close enough" to the contract.
 *
 * Deliberately `.strict()` on both sides: an unsupported input field is
 * rejected, not silently ignored, and a provider that produces an
 * unsupported output field or omits a required one is rejected too. A
 * model/heuristic "returned text" is never treated as success - only a
 * value that parses against `callSummaryOutputSchema` is.
 */

const MAX_TRANSCRIPT_TURNS = 500;
const MAX_TURN_TEXT_LENGTH = 4000;

export const transcriptTurnSchema = z
  .object({
    speaker: z.enum(["agent", "caller"]),
    text: z.string().min(1).max(MAX_TURN_TEXT_LENGTH),
  })
  .strict();
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

/**
 * `tenant_id` here is the field name the Skill's own input contract
 * requires - it must always be populated from a server-verified
 * tenant/session context by the caller (see CLAUDE.md §4), never trusted
 * from anything embedded in the transcript itself. The provider (see
 * providers/call-summary/index.ts) never reads a tenant/org identifier out
 * of `transcript` content - only this field is authoritative.
 */
export const callSummaryInputSchema = z
  .object({
    tenant_id: z.string().min(1, "tenant_id is required - missing tenant context fails closed"),
    call_id: z.string().min(1),
    transcript: z.array(transcriptTurnSchema).min(1).max(MAX_TRANSCRIPT_TURNS),
    /** Advisory only - the Skill always derives `language` from transcript content, never blindly trusts this. */
    language_hint: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "language_hint must look like an ISO 639-1 code, e.g. 'fi'")
      .optional(),
  })
  .strict();
export type CallSummaryInput = z.infer<typeof callSummaryInputSchema>;

export const callSummaryRiskFlagSchema = z.enum([
  "prompt_injection_attempt",
  "sensitive_information_detected",
  "abusive_or_threatening_language",
  "self_harm_or_crisis_mention",
]);
export type CallSummaryRiskFlag = z.infer<typeof callSummaryRiskFlagSchema>;

/** Minimum output contract required by the platform proof brief - every field is required, no extras. */
export const callSummaryOutputSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    caller_intent: z.string().min(1).max(200),
    key_points: z.array(z.string().min(1).max(500)).max(20),
    action_items: z.array(z.string().min(1).max(500)).max(20),
    follow_up_required: z.boolean(),
    risk_flags: z.array(callSummaryRiskFlagSchema).max(callSummaryRiskFlagSchema.options.length),
    language: z.string().min(2).max(16),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type CallSummaryOutput = z.infer<typeof callSummaryOutputSchema>;

/**
 * Operational metadata every execution must produce (task brief §7,
 * "Observability") - kept structurally separate from `CallSummaryOutput`
 * so the output contract stays exactly the 8 fields the brief specifies,
 * and separate from `AuditEvent.data` so nothing here has to duplicate what
 * `core/reporting/audit.ts` already scrubs. Deliberately excludes any
 * transcript content, contact names/numbers, or provider secrets - see
 * `docs/call-summary-skill.md` "Security" for what is and isn't logged.
 */
export const callSummaryExecutionMetaSchema = z
  .object({
    skill: z.literal("voice-pilot/call-summary"),
    skill_version: z.string().min(1),
    tenant_ref: z.string().min(1),
    provider: z.string().min(1),
    started_at: z.string(),
    ended_at: z.string(),
    duration_ms: z.number().nonnegative(),
    status: z.enum(["success", "failure"]),
    error_classification: z
      .enum(["none", "validation_error", "tenant_context_missing", "internal_error"])
      .default("none"),
  })
  .strict();
export type CallSummaryExecutionMeta = z.infer<typeof callSummaryExecutionMetaSchema>;

export const callSummaryResultSchema = z
  .object({
    output: callSummaryOutputSchema,
    meta: callSummaryExecutionMetaSchema,
  })
  .strict();
export type CallSummaryResult = z.infer<typeof callSummaryResultSchema>;
