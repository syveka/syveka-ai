import type { ExtractedBusinessDNA } from "@/lib/validators/business-dna";
import type { BusinessDnaTextFields } from "./merge-extracted";

/**
 * Per-field classification of a fresh website extraction against the
 * current (saved-or-in-progress) form value:
 *
 * - SAME: extraction agrees with the current value (or found nothing and
 *   there is nothing to flag) — no indicator shown.
 * - NEW: current value is empty, extraction found something — safe to
 *   apply automatically (there is nothing to lose).
 * - CONFLICT: both current and extracted are non-empty and meaningfully
 *   different — must NOT be auto-applied; the human picks explicitly.
 * - MISSING: an important field has no current value AND the extraction
 *   found nothing either — surfaced as "please verify," not an error.
 */
export type FieldClassification = "SAME" | "NEW" | "CONFLICT" | "MISSING";

export type FieldClassificationResult = {
  classification: FieldClassification;
  current: string;
  extracted: string | null;
};

/**
 * Fields whose absence is worth calling out to the user. Everything else in
 * `BusinessDnaTextFields` is a real, useful field but not one whose absence
 * should read as "please verify" — matching the mission's own instruction
 * not to treat every optional field as an error. This is an editorial
 * product decision, not a schema constraint: nothing in
 * `businessDnaSchema`/`extractedBusinessDnaSchema` marks any field as
 * required (every one is optional at the persistence layer).
 */
export const IMPORTANT_TEXT_FIELDS: ReadonlySet<keyof BusinessDnaTextFields> = new Set([
  "displayName",
  "description",
  "productsServices",
  "currency",
]);

/**
 * Comparison-only normalization — never used for display or persistence.
 * Collapses whitespace/line-ending/case differences that are pure
 * formatting, not semantic differences, so e.g. "Mon-Fri" vs "Mon-Fri "
 * (trailing space) or differing internal spacing doesn't register as a
 * false conflict. Deliberately does NOT strip punctuation, numbers, or
 * currency symbols — "€50" vs "€60" must keep comparing as different.
 */
export function normalizeForComparison(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ").toLowerCase();
}

function isBlank(value: string | undefined | null): value is undefined | null | "" {
  return value === undefined || value === null || value.trim().length === 0;
}

/** Classifies one text field. `extracted` is `undefined` when the extraction didn't return this field at all. */
export function classifyTextField(
  field: keyof BusinessDnaTextFields,
  current: string,
  extracted: string | undefined,
): FieldClassificationResult {
  const currentBlank = isBlank(current);
  const extractedBlank = isBlank(extracted);

  if (extractedBlank) {
    return {
      classification: currentBlank && IMPORTANT_TEXT_FIELDS.has(field) ? "MISSING" : "SAME",
      current,
      extracted: null,
    };
  }

  const extractedValue = extracted as string;

  if (currentBlank) {
    return { classification: "NEW", current, extracted: extractedValue };
  }

  const same = normalizeForComparison(current) === normalizeForComparison(extractedValue);
  return {
    classification: same ? "SAME" : "CONFLICT",
    current,
    extracted: extractedValue,
  };
}

export type TextFieldClassifications = Record<
  keyof BusinessDnaTextFields,
  FieldClassificationResult
>;

/**
 * Classifies every text field in one pass. `keyFacts` is compared as the
 * same newline-joined string shape the form already uses
 * (`mergeExtractedTextFields` does the same join) — not classified as a
 * per-fact list, matching the existing merge granularity rather than
 * inventing a finer one.
 */
export function classifyExtractedTextFields(
  current: BusinessDnaTextFields,
  extracted: ExtractedBusinessDNA,
): TextFieldClassifications {
  const extractedKeyFacts =
    extracted.keyFacts && extracted.keyFacts.length > 0 ? extracted.keyFacts.join("\n") : undefined;

  const fields: Array<[keyof BusinessDnaTextFields, string | undefined]> = [
    ["displayName", extracted.displayName],
    ["industry", extracted.industry],
    ["description", extracted.description],
    ["brandTone", extracted.brandTone],
    ["communicationStyle", extracted.communicationStyle],
    ["responseInstructions", extracted.responseInstructions],
    ["productsServices", extracted.productsServices],
    ["targetCustomer", extracted.targetCustomer],
    ["timezone", extracted.timezone],
    ["cancellationPolicy", extracted.cancellationPolicy],
    ["bookingPolicy", extracted.bookingPolicy],
    ["refundPolicy", extracted.refundPolicy],
    ["paymentPolicy", extracted.paymentPolicy],
    ["otherPolicies", extracted.otherPolicies],
    ["currency", extracted.currency],
    ["quoteInstructions", extracted.quoteInstructions],
    ["pricingNotes", extracted.pricingNotes],
    ["keyFacts", extractedKeyFacts],
  ];

  return Object.fromEntries(
    fields.map(([field, extractedValue]) => [
      field,
      classifyTextField(field, current[field], extractedValue),
    ]),
  ) as TextFieldClassifications;
}

/**
 * Applies only the NEW fields from a classification result — the one case
 * that is always safe to auto-apply without asking, because the current
 * value is empty and there is nothing to lose. SAME is a no-op by
 * definition; CONFLICT and MISSING are deliberately left untouched here —
 * a CONFLICT must never be applied without an explicit user choice, and a
 * MISSING field has no extracted value to apply in the first place.
 */
export function applyAutoAcceptedFields(
  current: BusinessDnaTextFields,
  classifications: TextFieldClassifications,
): BusinessDnaTextFields {
  const next = { ...current };
  for (const [field, result] of Object.entries(classifications) as Array<
    [keyof BusinessDnaTextFields, FieldClassificationResult]
  >) {
    if (result.classification === "NEW" && result.extracted !== null) {
      next[field] = result.extracted;
    }
  }
  return next;
}

/**
 * Resolves one explicit human decision on a CONFLICT field: "Use website
 * value" replaces the field with the extracted value; "Keep current"
 * returns the form state completely unchanged. This is the only place a
 * CONFLICT field's value can ever change — never automatically, only
 * through this explicit call driven by a button click.
 */
export function resolveFieldConflict(
  current: BusinessDnaTextFields,
  field: keyof BusinessDnaTextFields,
  review: FieldClassificationResult,
  useWebsiteValue: boolean,
): BusinessDnaTextFields {
  if (!useWebsiteValue || review.extracted === null) return current;
  return { ...current, [field]: review.extracted };
}

/**
 * Locale list classification (order-independent set comparison) —
 * intentionally simpler than the text-field model: there is no
 * "meaningful difference" threshold for a short enum list the way there is
 * for free text, so any set difference is either SAME or a genuine
 * CONFLICT/NEW.
 */
export function classifySupportedLocales(
  current: string[],
  extracted: string[] | undefined,
): FieldClassificationResult {
  if (!extracted || extracted.length === 0) {
    return { classification: "SAME", current: current.join(", "), extracted: null };
  }
  const currentSet = new Set(current);
  const extractedSet = new Set(extracted);
  const same =
    currentSet.size === extractedSet.size && [...currentSet].every((l) => extractedSet.has(l));
  if (same) return { classification: "SAME", current: current.join(", "), extracted: null };
  return {
    classification: current.length === 0 ? "NEW" : "CONFLICT",
    current: current.join(", "),
    extracted: extracted.join(", "),
  };
}
