import { z } from "zod";

/**
 * Input/output contract for the Voice Call Summary Skill (capability
 * `voice.summarize`). `.strict()` at every object level - an unexpected key
 * is a hard rejection, not a silently-dropped extra, matching
 * providers/remotion/input-schema.ts's precedent for a schema that sits at a
 * caller-influenced execution boundary.
 *
 * Deliberately excludes any field that could carry credentials/provider
 * configuration (no apiKey, model, temperature, endpoint, ...) - there is no
 * way for a caller to smuggle those through this schema, structurally, not
 * just by convention.
 */

export const callSummaryLanguageSchema = z.enum(["en", "fi", "unknown"]);
export type CallSummaryLanguage = z.infer<typeof callSummaryLanguageSchema>;

const MAX_TRANSCRIPT_CHARS = 50_000;

export const callSummaryMetadataSchema = z
  .object({
    durationSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

export const callSummaryInputSchema = z
  .object({
    /** The observed source of truth - free text, never parsed as instructions. */
    transcript: z
      .string()
      .min(1, "transcript must not be empty")
      .max(MAX_TRANSCRIPT_CHARS, `transcript must not exceed ${MAX_TRANSCRIPT_CHARS} characters`)
      .refine((s) => s.trim().length > 0, "transcript must not be whitespace-only"),
    /** Safe correlation identifier - opaque to this Skill, never a raw phone number/PII. */
    callId: z.string().min(1).max(200),
    language: callSummaryLanguageSchema.optional().default("unknown"),
    metadata: callSummaryMetadataSchema.optional(),
  })
  .strict();

export type CallSummaryInput = z.infer<typeof callSummaryInputSchema>;

export const urgencySchema = z.enum(["low", "medium", "high"]);
export const confidenceSchema = z.enum(["high", "medium", "low"]);

/**
 * Output explicitly separates three kinds of information, per the Skill's
 * own contract requirement:
 *   - keyFacts: observed transcript facts (short, literal, extractive)
 *   - summary / callerIntent / actionItems: derived summary
 *   - uncertain: information the provider could not confidently determine
 *     from the transcript - never silently omitted or guessed as fact
 */
export const callSummaryOutputSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    callerIntent: z.string().min(1).max(500),
    keyFacts: z.array(z.string().min(1).max(500)).max(20),
    actionItems: z.array(z.string().min(1).max(500)).max(10),
    followUpRequired: z.boolean(),
    urgency: urgencySchema,
    language: callSummaryLanguageSchema,
    confidence: confidenceSchema,
    /** Explicitly-flagged unknown/uncertain items - never merged into keyFacts. */
    uncertain: z.array(z.string().min(1).max(500)).max(10).optional(),
  })
  .strict();

export type CallSummaryOutput = z.infer<typeof callSummaryOutputSchema>;
