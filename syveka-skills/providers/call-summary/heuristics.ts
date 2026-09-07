import type { CallSummaryRiskFlag, TranscriptTurn } from "../../schemas/call-summary.js";

/**
 * The actual analysis logic behind the "voice-pilot/call-summary" Skill's
 * reference provider (see index.ts). Deliberately deterministic, offline,
 * pure-function heuristics rather than a live LLM call - see
 * docs/call-summary-skill.md "Why the reference provider is deterministic"
 * for the reasoning. Every function here is a real, testable computation
 * over the transcript text - never a fabricated or hardcoded result -
 * which is what lets this provider honestly earn `integration_state:
 * VERIFIED` (see docs/skills-registry.md) without a live third-party
 * dependency in the loop.
 *
 * SECURITY: nothing in this file ever treats transcript text as
 * instructions. Every function below only ever reads it as data to pattern-
 * match against - there is no code path from "transcript contains X" to
 * "behave differently", other than the risk_flags/summary/intent output
 * fields the Skill contract explicitly defines.
 */

const ARABIC_RANGE = /[؀-ۿ]/;
const FINNISH_MARKERS = /[äöÄÖ]|\b(kiitos|hyvää|kyllä|ei|soitan|varaus|peruutan|asiakaspalvelu)\b/i;

export interface LanguageDetection {
  language: string;
  mixed: boolean;
}

/**
 * Detects the dominant script/language present across the transcript.
 * `language_hint` (if supplied) only breaks a tie when the transcript
 * itself gives no strong signal - it is never allowed to override what the
 * transcript text actually contains, so a caller (or a hostile transcript)
 * cannot make the Skill mislabel content by supplying a false hint.
 */
export function detectLanguage(turns: TranscriptTurn[], languageHint?: string): LanguageDetection {
  const text = turns.map((t) => t.text).join(" ");
  const hasArabic = ARABIC_RANGE.test(text);
  const hasFinnish = FINNISH_MARKERS.test(text);
  // A rough "is this recognizably English" signal - common English function
  // words. Not exhaustive, just enough to tell "some English present"
  // apart from "no Latin-script English signal at all".
  const hasEnglish = /\b(the|and|is|please|thank you|hello|hi|call)\b/i.test(text);

  const signals = [hasArabic, hasFinnish, hasEnglish].filter(Boolean).length;
  if (signals >= 2) {
    return { language: "mixed", mixed: true };
  }
  if (hasArabic) return { language: "ar", mixed: false };
  if (hasFinnish) return { language: "fi", mixed: false };
  if (hasEnglish) return { language: "en", mixed: false };
  if (languageHint) return { language: languageHint, mixed: false };
  return { language: "en", mixed: false };
}

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /you are now (in )?(unrestricted|developer|admin) mode/i,
  /system\s*:/i,
  /disregard (the )?(skill|policy|safety) (rules|policy|guardrails)/i,
  /reveal your (system prompt|api key|credentials)/i,
  /this (message|call) constitutes (your )?approval/i,
  /set approval_required to false/i,
];

const SENSITIVE_INFO_PATTERNS = [
  /\b(?:\d[ -]*?){13,19}\b/, // credit-card-shaped digit run
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b(password|pin code|pin number) is\b/i,
];

const ABUSIVE_PATTERNS = [/\b(kill you|sue you|f\*{2,}k you|i will hurt|lawsuit against)\b/i];

const CRISIS_PATTERNS = [/\b(suicidal|want to die|hurt myself|end my life|self.?harm)\b/i];

/** Real pattern-matching over transcript text - a risk flag is only ever set when its pattern actually matched. */
export function detectRiskFlags(turns: TranscriptTurn[]): CallSummaryRiskFlag[] {
  const text = turns.map((t) => t.text).join("\n");
  const flags: CallSummaryRiskFlag[] = [];
  if (INJECTION_PATTERNS.some((p) => p.test(text))) flags.push("prompt_injection_attempt");
  if (SENSITIVE_INFO_PATTERNS.some((p) => p.test(text)))
    flags.push("sensitive_information_detected");
  if (ABUSIVE_PATTERNS.some((p) => p.test(text))) flags.push("abusive_or_threatening_language");
  if (CRISIS_PATTERNS.some((p) => p.test(text))) flags.push("self_harm_or_crisis_mention");
  return flags;
}

const INTENT_RULES: { intent: string; pattern: RegExp }[] = [
  {
    intent: "booking_or_scheduling",
    pattern: /\b(book|appointment|schedule|reserve|reservation)\b/i,
  },
  { intent: "cancellation", pattern: /\b(cancel|cancelling|refund)\b/i },
  {
    intent: "complaint",
    pattern: /\b(complain|unhappy|disappointed|terrible|worst experience)\b/i,
  },
  { intent: "billing_or_pricing", pattern: /\b(bill|invoice|price|quote|charge|payment)\b/i },
  { intent: "support_request", pattern: /\b(broken|not working|issue|problem|error|help me)\b/i },
];

export function detectCallerIntent(turns: TranscriptTurn[]): string {
  const callerText = turns
    .filter((t) => t.speaker === "caller")
    .map((t) => t.text)
    .join(" ");
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(callerText)) return rule.intent;
  }
  return "general_inquiry";
}

const ACTION_MARKERS =
  /\b(will call (you )?back|need to|please send|schedule a|follow up|get back to you|i'?ll (check|arrange|send))\b/i;

const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

function sanitizeSentence(sentence: string): string {
  // Strip control characters and collapse whitespace - defense against a
  // transcript turn containing formatting designed to break downstream
  // rendering, never an attempt to interpret the sentence's meaning.
  return sentence.replace(CONTROL_CHAR_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(sanitizeSentence)
    .filter((s) => s.length > 0);
}

export interface ExtractedPoints {
  keyPoints: string[];
  actionItems: string[];
}

const MAX_KEY_POINTS = 8;
const MAX_ACTION_ITEMS = 8;

/** Splits caller/agent sentences into key points vs. action items - a real (if simple) text split, not a fabricated list. */
export function extractPoints(turns: TranscriptTurn[]): ExtractedPoints {
  const keyPoints: string[] = [];
  const actionItems: string[] = [];

  for (const turn of turns) {
    for (const sentence of splitSentences(turn.text)) {
      if (ACTION_MARKERS.test(sentence)) {
        if (actionItems.length < MAX_ACTION_ITEMS) actionItems.push(sentence.slice(0, 500));
      } else if (keyPoints.length < MAX_KEY_POINTS) {
        keyPoints.push(sentence.slice(0, 500));
      }
    }
  }

  return { keyPoints, actionItems };
}

/**
 * Confidence reflects genuine signal strength, not a fixed constant:
 * shorter transcripts and mixed-language content are real sources of
 * uncertainty for a heuristic summarizer, so both measurably lower it.
 */
export function computeConfidence(params: { turnCount: number; mixedLanguage: boolean }): number {
  let confidence = 0.9;
  if (params.turnCount < 3) confidence -= 0.3;
  else if (params.turnCount < 6) confidence -= 0.1;
  if (params.mixedLanguage) confidence -= 0.15;
  return Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2))));
}

export function buildSummarySentence(params: {
  intent: string;
  turnCount: number;
  actionItemCount: number;
}): string {
  const intentLabel = params.intent.replace(/_/g, " ");
  const actionClause =
    params.actionItemCount > 0
      ? `${params.actionItemCount} action item(s) were identified.`
      : "No follow-up action was identified.";
  return (
    `Call classified as ${intentLabel} across ${params.turnCount} transcript turn(s). ` +
    actionClause
  );
}
