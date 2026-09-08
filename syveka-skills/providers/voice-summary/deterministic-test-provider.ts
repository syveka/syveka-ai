import type { Provider } from "../types.js";
import type { ProviderResult } from "../../schemas/index.js";
import {
  callSummaryInputSchema,
  callSummaryOutputSchema,
  type CallSummaryOutput,
} from "./schema.js";

/**
 * TEST-ONLY deterministic stand-in for a real voice.summarize provider.
 * Never exported from providers/voice-summary/index.ts, never registered in
 * any real providerMap - imported directly by evals/voice-call-summary.test.ts
 * only. Requires no network, no API key, no LLM call.
 *
 * Output is derived ALGORITHMICALLY from structural properties of the
 * transcript (keyword counts via fixed word-boundary regexes, word count,
 * sentence splitting) - never by looking for or obeying "field: value"-shaped
 * text inside the transcript. This is a deliberate security property, not
 * an implementation detail: the transcript is DATA a human said out loud on
 * a phone call, not a system instruction, and this provider must behave
 * identically whether or not it contains text that reads like an attempt to
 * dictate the output (see evals/voice-call-summary.test.ts's prompt-injection
 * case, mirroring evals/untrusted-web-content.test.ts's existing pattern for
 * scraped content).
 *
 * Pure and stateless: identical input always produces identical output, and
 * no state is retained between calls - so there is no way for one call's
 * transcript to influence another's result (no cross-call data leakage).
 */

const URGENT_KEYWORDS = /\b(emergency|urgent|immediately|asap|right away|critical)\b/gi;
const FOLLOW_UP_KEYWORDS = /\b(call (me )?back|follow[- ]?up|reach out|get back to (me|us))\b/i;
const MAX_KEY_FACTS = 3;

function splitSentences(transcript: string): string[] {
  return transcript
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface DeterministicVoiceSummaryOptions {
  /** For negative-path tests: force a structurally invalid output. */
  forceMalformedOutput?: boolean;
  /** For negative-path tests: force execute() to throw. */
  forceThrow?: boolean;
}

function deriveOutput(
  transcript: string,
  language: CallSummaryOutput["language"],
): CallSummaryOutput {
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  const urgentHits = transcript.match(URGENT_KEYWORDS)?.length ?? 0;
  const urgency = urgentHits >= 2 ? "high" : urgentHits === 1 ? "medium" : "low";
  const confidence = wordCount >= 30 ? "high" : wordCount >= 10 ? "medium" : "low";
  const followUpRequired = FOLLOW_UP_KEYWORDS.test(transcript);

  const sentences = splitSentences(transcript);
  const keyFacts = sentences.slice(0, MAX_KEY_FACTS).map((s) => truncate(s, 500));
  const callerIntent =
    sentences.length > 0
      ? truncate(sentences[0]!, 500)
      : "Unknown - unable to determine caller intent from transcript";
  const summary = truncate(
    `Call with ${wordCount} word(s) across ${sentences.length} sentence(s). ` +
      `Urgency signals detected: ${urgentHits}. ` +
      (followUpRequired ? "Follow-up requested." : "No explicit follow-up requested."),
    2000,
  );
  const actionItems = followUpRequired ? ["Follow up with caller"] : [];
  const uncertain = wordCount < 5 ? ["Transcript too short to confidently summarize"] : undefined;

  return {
    summary,
    callerIntent,
    keyFacts,
    actionItems,
    followUpRequired,
    urgency,
    language,
    confidence,
    uncertain,
  };
}

export function createDeterministicVoiceSummaryProvider(
  options: DeterministicVoiceSummaryOptions = {},
): Provider {
  return {
    id: "voice-summary-deterministic-test-double",
    isAvailable: () => true,
    async execute(input: Record<string, unknown>): Promise<ProviderResult> {
      if (options.forceThrow) {
        throw new Error("forced failure for negative-path testing");
      }

      const parsed = callSummaryInputSchema.safeParse({
        transcript: input.transcript,
        callId: input.callId,
        language: input.language,
        metadata: input.metadata,
      });

      if (!parsed.success) {
        return {
          status: "FAILURE",
          // Never interpolate raw input into the message - only the
          // validator's own field-path/issue-code output, which cannot
          // contain transcript content.
          message: `input validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; ")}`,
          evidence: [],
        };
      }

      if (options.forceMalformedOutput) {
        // Deliberately schema-invalid (missing required fields) - proves
        // the caller's own output validation catches a malformed provider
        // response rather than trusting it blindly.
        return {
          status: "SUCCESS",
          message: "call summarized (malformed - test only)",
          evidence: [],
          data: { summary: "incomplete" } as unknown,
        };
      }

      const output = deriveOutput(parsed.data.transcript, parsed.data.language);
      const outputCheck = callSummaryOutputSchema.safeParse(output);
      if (!outputCheck.success) {
        // Should be unreachable given deriveOutput's own bounds, but fails
        // closed rather than returning unvalidated data if it ever isn't.
        return {
          status: "FAILURE",
          message: "internal error: derived output failed its own schema",
          evidence: [],
        };
      }

      return {
        status: "SUCCESS",
        message: "call summarized",
        // Evidence intentionally carries only safe, non-transcript
        // identifiers - never the raw transcript text.
        evidence: [
          {
            type: "artifact",
            description: `Call summary generated for callId=${parsed.data.callId}`,
            data: JSON.stringify({
              callId: parsed.data.callId,
              urgency: outputCheck.data.urgency,
              confidence: outputCheck.data.confidence,
              followUpRequired: outputCheck.data.followUpRequired,
            }),
            timestamp: new Date().toISOString(),
          },
        ],
        data: outputCheck.data,
      };
    },
  };
}
