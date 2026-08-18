import { evaluateSufficiency } from "../evidence/index.js";
import type { EvidenceBundle, VerificationResult } from "../../schemas/index.js";
import type { ProviderResultStatus } from "../../schemas/index.js";

export interface VerifyInput {
  evidence: EvidenceBundle;
  /** What the provider that did the work actually reported - structured, not narrated. */
  providerOutcome: ProviderResultStatus;
  /**
   * Deliberately accepted but NEVER read by the decision logic below. This
   * is the anti-sycophancy contract made mechanical rather than just
   * documented: a caller can tell verify() the user is pressuring for a
   * pass, and it changes nothing about the outcome. Kept as a parameter
   * (rather than omitted entirely) so callers/evals can assert this
   * explicitly - see evals/anti-sycophancy.test.ts.
   */
  userAssertsComplete?: boolean;
}

/**
 * The evidence-first gate. This function - not the executing provider, not
 * the calling agent, not the user - is the single place that decides
 * VERIFIED vs UNVERIFIED vs FAILED. See docs/evidence-model.md for the
 * full contract this implements.
 */
export function verify(input: VerifyInput): VerificationResult {
  const { evidence, providerOutcome } = input;

  if (providerOutcome === "FAILURE") {
    return {
      status: "FAILED",
      reason: "the executing provider reported failure - evidence shows the work did not succeed",
      evidence,
    };
  }

  if (providerOutcome === "UNAVAILABLE") {
    return {
      status: "UNVERIFIED",
      reason: "no provider was available to perform or verify the work",
      evidence,
    };
  }

  const sufficiency = evaluateSufficiency(evidence);
  if (!sufficiency.sufficient) {
    return {
      status: "UNVERIFIED",
      reason: `provider reported success, but ${sufficiency.reason}`,
      evidence,
    };
  }

  return {
    status: "VERIFIED",
    reason: "provider reported success and evidence includes at least one strong, checkable item",
    evidence,
  };
}
