import type { CallSummaryLanguage, CallSummaryOutput } from "./schema.js";

/**
 * Pure, unit-tested mapping helpers between the existing production Voice
 * post-call contract (src/app/api/v1/jobs/post-call/route.ts, READ-ONLY,
 * never modified by this mission) and the voice.summarize Skill contract.
 *
 * NOT wired into the production route. NOT imported by any production
 * code path. Exists to prove the mapping is well-defined and to give a
 * future, separately-authorized production-integration PR a starting
 * point - see docs/skills/voice-call-summary.md "Production integration
 * adapter" and "Migration plan".
 */

// ---------------------------------------------------------------------------
// Production -> Skill (building the Skill's structured input)
// ---------------------------------------------------------------------------

/**
 * Production's `call.assistant.language` is a Prisma `Locale` enum value
 * (EN | FI | AR - see prisma/schema.prisma). The Skill's
 * CallSummaryLanguage is narrower (en | fi | unknown) and does NOT yet have
 * an "ar" value - a genuine contract gap (see docs/skills/voice-call-summary.md
 * "Compatibility matrix", field: language, classification: D - missing in
 * Skill contract). AR maps to "unknown" here rather than silently to "en" -
 * unlike production's own current ternary (`=== "FI" ? Finnish : English`),
 * which already collapses AR into English today. This mapping deliberately
 * does NOT repeat that collapse; extending callSummaryLanguageSchema with a
 * real "ar" value is out of scope for this mission (a schema/contract
 * change requires its own explicit authorization) and is listed as a
 * blocker in the readiness report instead.
 */
export function mapProductionLocaleToSkillLanguage(
  locale: "EN" | "FI" | "AR",
): CallSummaryLanguage {
  if (locale === "EN") return "en";
  if (locale === "FI") return "fi";
  return "unknown";
}

/**
 * Production's `call.transcript` is an untyped Prisma `Json?` column with
 * no enforced shape (prisma/schema.prisma line ~1271) - the route itself
 * only ever does `JSON.stringify(call.transcript ?? [])`, i.e. it has no
 * normalized "speaker: text" representation today either. Because there is
 * no verified shape to parse, this module deliberately does NOT attempt to
 * turn a raw `call.transcript` JSON value into transcript text - that would
 * be guessing at an unverified schema. Instead the seam is defined one
 * level up: a future adapter must first normalize `call.transcript` into
 * plain dialogue text (its own, separately-scoped task - see "Migration
 * plan" stage 1), and pass the result in as `transcriptText` here.
 */
export interface NormalizedProductionCallContext {
  transcriptText: string;
  callId: string;
  locale: "EN" | "FI" | "AR";
  durationSeconds?: number;
}

export interface SkillInputFields {
  transcript: string;
  callId: string;
  language: CallSummaryLanguage;
  metadata?: { durationSeconds?: number };
}

export function buildSkillInputFromNormalizedCall(
  context: NormalizedProductionCallContext,
): SkillInputFields {
  return {
    transcript: context.transcriptText,
    callId: context.callId,
    language: mapProductionLocaleToSkillLanguage(context.locale),
    metadata:
      context.durationSeconds === undefined
        ? undefined
        : { durationSeconds: context.durationSeconds },
  };
}

// ---------------------------------------------------------------------------
// Skill -> Production (mapping the Skill's structured output back to the
// existing `analysisSchema` shape production writes to the DB)
// ---------------------------------------------------------------------------

const MAX_PRODUCTION_FOLLOW_UPS = 5;

export type ProductionSentiment = "positive" | "neutral" | "negative";

export interface ProductionAnalysisFields {
  summary: string;
  /**
   * Always null: the Skill's output contract has no sentiment field (see
   * compatibility matrix classification E - semantically conflicting /
   * D - missing in Skill contract). `urgency` and `sentiment` are NOT the
   * same axis (a call can be high-urgency and neutral-sentiment, or
   * low-urgency and negative-sentiment) and deriving one from the other
   * would be fabricating data the transcript may not support - exactly
   * what Phase 10's fabrication review forbids. A real integration needs
   * either a dedicated sentiment classification step or a schema change to
   * add a real sentiment field to callSummaryOutputSchema - both out of
   * scope here.
   */
  sentiment: null;
  followUps: string[];
}

export interface ProductionMappingResult {
  fields: ProductionAnalysisFields;
  /** Non-fatal notes about lossy or unmapped data - never silently dropped. */
  warnings: string[];
}

/**
 * Deterministic, side-effect-free. Does not touch the database and is not
 * called from src/app/api/v1/jobs/post-call/route.ts.
 */
export function mapSkillOutputToProductionAnalysis(
  output: CallSummaryOutput,
): ProductionMappingResult {
  const warnings: string[] = [];

  if (output.actionItems.length > MAX_PRODUCTION_FOLLOW_UPS) {
    warnings.push(
      `actionItems has ${output.actionItems.length} items; production's followUps field ` +
        `accepts at most ${MAX_PRODUCTION_FOLLOW_UPS} (analysisSchema.followUps.max(5)) - ` +
        `truncated, not dropped silently.`,
    );
  }
  if (output.uncertain && output.uncertain.length > 0) {
    warnings.push(
      `output has ${output.uncertain.length} "uncertain" item(s) with no corresponding ` +
        `production DB field - not persisted by this mapping.`,
    );
  }
  warnings.push(
    "sentiment: no source field in the Skill output contract - see ProductionAnalysisFields.sentiment doc comment.",
  );

  return {
    fields: {
      summary: output.summary,
      sentiment: null,
      followUps: output.actionItems.slice(0, MAX_PRODUCTION_FOLLOW_UPS),
    },
    warnings,
  };
}
