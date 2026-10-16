import type { Provider } from "../types.js";
import type { EvidenceItem, ProviderResult } from "../../schemas/index.js";
import { callSummaryInputSchema, callSummaryOutputSchema } from "./schema.js";
import { buildSystemInstructions } from "./prompt.js";
import type { VoiceSummaryCompletionClient } from "./completion-client.js";

/**
 * The real (vendor-backed) voice.summarize provider. NOT exported from
 * providers/voice-summary/index.ts, NOT registered in any real
 * providerMap, NOT wired into production - see docs/skills/voice-call-summary.md
 * "Production status" and core/registry/data.ts's "voice-summary" entry
 * (still status: REVIEW / integration_state: REFERENCE). This module exists
 * to prove the provider CAN be implemented correctly against the existing
 * architecture, tested deterministically with an injected mock client - not
 * to activate production traffic.
 *
 * Takes an already-constructed VoiceSummaryCompletionClient (see
 * completion-client.ts) rather than importing any vendor SDK directly -
 * this file has zero network/vendor-specific imports, matching the
 * provider-agnostic-core requirement. A future production integration PR
 * supplies the real client from the root app; evals/voice-summary-real-provider.test.ts
 * supplies a deterministic mock.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

function stripMarkdownFence(text: string): string {
  return text.replace(/^```json?\s*|```\s*$/g, "").trim();
}

function timeoutError(): Error {
  return new Error("voice_summary_provider_timeout");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const candidate = "status" in record ? record.status : record.statusCode;
  return typeof candidate === "number" ? candidate : undefined;
}

/**
 * Classifies a thrown client error into a stable code and a fixed, generic
 * message. Deliberately never forwards `error.message` verbatim - a vendor
 * SDK error can echo request content (up to and including transcript
 * fragments) in its message, so only our own fixed strings ever reach the
 * ProviderResult/evidence surface.
 */
function classifyClientError(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.message === "voice_summary_provider_timeout") {
    return { code: "TIMEOUT", message: "provider request timed out" };
  }
  const status = extractHttpStatus(error);
  if (status === 429) return { code: "RATE_LIMITED", message: "provider rate limit exceeded" };
  if (status !== undefined && status >= 500) {
    return { code: "PROVIDER_OUTAGE", message: "provider service error" };
  }
  return { code: "PROVIDER_ERROR", message: "provider request failed" };
}

export interface VoiceSummaryProviderOptions {
  timeoutMs?: number;
}

export function createVoiceSummaryProvider(
  client: VoiceSummaryCompletionClient,
  options: VoiceSummaryProviderOptions = {},
): Provider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "voice-summary-real",
    isAvailable: () => client.isConfigured(),
    async execute(input: Record<string, unknown>): Promise<ProviderResult> {
      const parsedInput = callSummaryInputSchema.safeParse({
        transcript: input.transcript,
        callId: input.callId,
        language: input.language,
        metadata: input.metadata,
      });
      if (!parsedInput.success) {
        return {
          status: "FAILURE",
          message: `input validation failed: ${parsedInput.error.issues
            .map((i) => `${i.path.join(".")}: ${i.code}`)
            .join("; ")}`,
          evidence: [],
        };
      }

      // Defense in depth: even if a caller constructs this provider and
      // calls execute() directly without checking isAvailable() first (the
      // router always does, but this file must not rely on that), fail
      // closed rather than attempting a call with no credentials.
      if (!client.isConfigured()) {
        return {
          status: "UNAVAILABLE",
          message:
            "voice-summary-real provider is not configured (no credentials injected) - " +
            "see providers/voice-summary/completion-client.ts",
          evidence: [],
        };
      }

      const { transcript, callId, language } = parsedInput.data;
      const systemInstructions = buildSystemInstructions(language);

      let response;
      const startedAt = Date.now();
      try {
        response = await withTimeout(
          client.complete({ systemInstructions, transcriptData: transcript, language }),
          timeoutMs,
        );
      } catch (error) {
        const { code, message } = classifyClientError(error);
        return {
          status: "FAILURE",
          message: `provider call failed (${code}): ${message}`,
          evidence: [],
        };
      }

      const cleanText = stripMarkdownFence(response.rawText);
      if (cleanText.length === 0) {
        return {
          status: "FAILURE",
          message: "provider returned an empty completion",
          evidence: [],
        };
      }

      let candidate: unknown;
      try {
        candidate = JSON.parse(cleanText);
      } catch {
        return { status: "FAILURE", message: "provider response was not valid JSON", evidence: [] };
      }

      const outputCheck = callSummaryOutputSchema.safeParse(candidate);
      if (!outputCheck.success) {
        // .strict() rejects any unexpected key - including one an injected
        // instruction might try to add (e.g. an "apiKey" or "systemPrompt"
        // field) - so a schema-invalid response fails closed here rather
        // than silently stripping and passing through unknown data.
        return {
          status: "FAILURE",
          message: `provider response failed output schema validation: ${outputCheck.error.issues
            .map((i) => `${i.path.join(".")}: ${i.code}`)
            .join("; ")}`,
          evidence: [],
        };
      }

      const evidence: EvidenceItem[] = [
        {
          type: "artifact",
          description: `Call summary generated for callId=${callId}`,
          // Only safe, non-transcript identifiers and model metadata - never
          // the raw transcript, the raw model response text, or the system
          // instructions.
          data: JSON.stringify({
            callId,
            urgency: outputCheck.data.urgency,
            confidence: outputCheck.data.confidence,
            followUpRequired: outputCheck.data.followUpRequired,
            model: response.model,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            latencyMs: Date.now() - startedAt,
          }),
          timestamp: new Date().toISOString(),
        },
      ];

      return {
        status: "SUCCESS",
        message: "call summarized",
        evidence,
        data: outputCheck.data,
      };
    },
  };
}
