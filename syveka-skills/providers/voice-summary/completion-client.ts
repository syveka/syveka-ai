import type { CallSummaryLanguage } from "./schema.js";

/**
 * The dependency-injection seam between this Skill and a real AI vendor.
 *
 * `syveka-skills` is an intentionally separate, unlinked npm package (see
 * package.json - no workspace reference to the root app, no
 * `@anthropic-ai/sdk` dependency). It must never import the root app's
 * `src/server/integrations/anthropic.ts` directly, and it must never read
 * `process.env` for a vendor API key itself - both would violate the
 * charter's "validate environment configuration per integration" principle
 * by smuggling a Next.js-specific, `server-only` module and its env
 * contract into a generic orchestration package, and would duplicate
 * credential bootstrap that already exists in the root app.
 *
 * Instead, this Skill defines the narrow *shape* of what it needs from a
 * completion vendor, and the root app (never this package) is responsible
 * for implementing `VoiceSummaryCompletionClient` using its own
 * already-configured `anthropic` client (see docs/skills/voice-call-summary.md
 * "Production integration adapter") and injecting it at construction time -
 * the same trust boundary `OrchestratorDeps.providerMap` already uses.
 *
 * No implementation of this interface exists in syveka-skills itself other
 * than the honest "unconfigured" stub below. A real implementation is root
 * app code, wired only when a future, separately-authorized production
 * integration PR does so.
 */

export interface VoiceSummaryCompletionRequest {
  /**
   * Fixed instructions for this call, built ONLY from the validated
   * `language` field (see prompt.ts) - never from `transcriptData` or any
   * other caller-supplied text. A client implementation must send this as
   * the model's system/developer instructions, kept structurally separate
   * from `transcriptData`.
   */
  systemInstructions: string;
  /**
   * The transcript, treated as opaque DATA. A client implementation must
   * never concatenate this into systemInstructions or otherwise treat any
   * of its content as an instruction.
   */
  transcriptData: string;
  language: CallSummaryLanguage;
}

export interface VoiceSummaryCompletionResponse {
  /** Raw text returned by the model - not yet parsed or validated. */
  rawText: string;
  /** Model identifier actually used, for evidence/audit metadata only. */
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface VoiceSummaryCompletionClient {
  /**
   * Must reflect real configuration state (e.g. an API key is present),
   * never optimistically return true - same honesty requirement as
   * Provider.isAvailable() (see providers/unavailable-stub.ts).
   */
  isConfigured(): boolean;
  /**
   * Performs exactly one completion request. Must not retry internally in
   * a way that hides cost/latency from the caller - real-provider.ts owns
   * timeout and error classification.
   */
  complete(request: VoiceSummaryCompletionRequest): Promise<VoiceSummaryCompletionResponse>;
}

export class VoiceSummaryProviderConfigError extends Error {}

/**
 * Honest default: no client is configured until the root app injects a
 * real one. Mirrors createUnavailableStubProvider's contract - never
 * pretends to be configured, never called without the caller already
 * having checked isConfigured() in well-behaved code, but fails closed
 * with a safe, non-leaking error even if it is.
 */
export function createUnconfiguredCompletionClient(reason: string): VoiceSummaryCompletionClient {
  return {
    isConfigured: () => false,
    async complete() {
      throw new VoiceSummaryProviderConfigError(reason);
    },
  };
}
