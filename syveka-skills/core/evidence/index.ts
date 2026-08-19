import type { EvidenceBundle, EvidenceItem } from "../../schemas/index.js";

export class EvidenceCollector {
  private items: EvidenceItem[] = [];

  constructor(private readonly claim: string) {}

  attach(item: Omit<EvidenceItem, "timestamp">): void {
    this.items.push({ ...item, timestamp: new Date().toISOString() });
  }

  bundle(): EvidenceBundle {
    return { claim: this.claim, items: [...this.items] };
  }
}

/**
 * Evidence types strong enough, on their own, to support a completion
 * claim. A "log" or "source_reference" alone is treated as weak - useful
 * context, not proof something works - matching the evidence-first
 * principle that a screenshot or a confident description is not the same
 * as a test result. See docs/evidence-model.md.
 */
const STRONG_EVIDENCE_TYPES = new Set<EvidenceItem["type"]>([
  "test",
  "build",
  "ci_check",
  "diff",
  "database_query",
]);

export interface EvidenceSufficiency {
  sufficient: boolean;
  reason: string;
}

/**
 * Judges whether a bundle is strong enough to support ITS OWN claim - not
 * whether the claim is TRUE. A test that ran and failed is "sufficient
 * evidence" in the sense that it's real proof of something; whether that
 * something supports "fixed" is verification's job (see
 * core/verification), not this function's. This function only answers:
 * "is there real, checkable evidence here at all, or just an assertion?"
 */
export function evaluateSufficiency(bundle: EvidenceBundle): EvidenceSufficiency {
  if (bundle.items.length === 0) {
    return { sufficient: false, reason: "no evidence attached - a bare claim is not proof" };
  }
  const hasStrong = bundle.items.some((i) => STRONG_EVIDENCE_TYPES.has(i.type));
  if (!hasStrong) {
    return {
      sufficient: false,
      reason:
        "only weak evidence types present (log/screenshot/source_reference/artifact) - " +
        "a completion claim needs at least one test, build, CI check, diff, or database query",
    };
  }
  return { sufficient: true, reason: "at least one strong evidence item present" };
}
