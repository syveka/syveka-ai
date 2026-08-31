import { describe, expect, it } from "vitest";
import {
  applyAutoAcceptedFields,
  classifyExtractedTextFields,
  classifySupportedLocales,
  classifyTextField,
  normalizeForComparison,
  resolveFieldConflict,
  IMPORTANT_TEXT_FIELDS,
} from "@/lib/business-dna/classify-extracted";
import type { BusinessDnaTextFields } from "@/lib/business-dna/merge-extracted";
import type { ExtractedBusinessDNA } from "@/lib/validators/business-dna";

function currentFields(overrides: Partial<BusinessDnaTextFields> = {}): BusinessDnaTextFields {
  return {
    displayName: "Fruppi Toys",
    industry: "Toys",
    description: "Handmade plush toys",
    brandTone: "",
    communicationStyle: "",
    responseInstructions: "",
    productsServices: "Plush toys",
    targetCustomer: "",
    timezone: "",
    cancellationPolicy: "",
    bookingPolicy: "",
    refundPolicy: "",
    paymentPolicy: "",
    otherPolicies: "",
    currency: "EUR",
    quoteInstructions: "",
    pricingNotes: "",
    keyFacts: "",
    ...overrides,
  };
}

describe("classifyTextField", () => {
  // 1. current empty + extracted value -> NEW
  it("classifies an empty current field with a found extracted value as NEW", () => {
    const result = classifyTextField("brandTone", "", "Friendly and warm");
    expect(result.classification).toBe("NEW");
    expect(result.extracted).toBe("Friendly and warm");
  });

  // 2. current same + extracted same -> SAME
  it("classifies an identical value as SAME", () => {
    const result = classifyTextField("displayName", "Fruppi Toys", "Fruppi Toys");
    expect(result.classification).toBe("SAME");
  });

  // 3. whitespace-only difference -> SAME
  it("treats a whitespace-only difference as SAME, not a conflict", () => {
    const result = classifyTextField(
      "description",
      "Handmade  plush   toys",
      "Handmade plush toys",
    );
    expect(result.classification).toBe("SAME");
  });

  it("treats a line-ending-only difference as SAME", () => {
    const result = classifyTextField("otherPolicies", "Line one\r\nLine two", "Line one\nLine two");
    expect(result.classification).toBe("SAME");
  });

  it("treats a case-only difference as SAME", () => {
    const result = classifyTextField("industry", "toys", "Toys");
    expect(result.classification).toBe("SAME");
  });

  // 4. meaningful difference -> CONFLICT
  it("classifies a real value difference as CONFLICT", () => {
    const result = classifyTextField("currency", "EUR", "USD");
    expect(result.classification).toBe("CONFLICT");
    expect(result.current).toBe("EUR");
    expect(result.extracted).toBe("USD");
  });

  it("does not collapse a genuine price-like difference into SAME", () => {
    // pricingNotes is free text, not a currency field, but the same
    // normalization rules apply — only formatting collapses, not values.
    const result = classifyTextField("pricingNotes", "From €50", "From €60");
    expect(result.classification).toBe("CONFLICT");
  });

  // 5. required (important) field + no extracted value -> MISSING
  it("classifies an important field with no current value and no extraction as MISSING", () => {
    expect(IMPORTANT_TEXT_FIELDS.has("displayName")).toBe(true);
    const result = classifyTextField("displayName", "", undefined);
    expect(result.classification).toBe("MISSING");
  });

  // 6. optional field + no extracted value -> no unnecessary warning (SAME)
  it("classifies a non-important field with no current value and no extraction as SAME (no warning)", () => {
    expect(IMPORTANT_TEXT_FIELDS.has("brandTone")).toBe(false);
    const result = classifyTextField("brandTone", "", undefined);
    expect(result.classification).toBe("SAME");
  });

  it("classifies an important field that already has a current value as SAME when extraction finds nothing (nothing to verify)", () => {
    const result = classifyTextField("displayName", "Fruppi Toys", undefined);
    expect(result.classification).toBe("SAME");
  });

  it("treats an all-whitespace extracted value as blank, not as data", () => {
    const result = classifyTextField("industry", "", "   ");
    expect(result.classification).toBe("SAME"); // industry is not important, so blank+blank -> SAME
    expect(result.extracted).toBeNull();
  });

  it("treats an all-whitespace extracted value as blank for an important field too, surfacing MISSING", () => {
    const result = classifyTextField("displayName", "", "   ");
    expect(result.classification).toBe("MISSING");
  });
});

describe("normalizeForComparison", () => {
  it("collapses internal whitespace runs", () => {
    expect(normalizeForComparison("Mon   Fri")).toBe(normalizeForComparison("Mon Fri"));
  });

  it("is case-insensitive", () => {
    expect(normalizeForComparison("EUR")).toBe(normalizeForComparison("eur"));
  });

  it("does not strip meaningful punctuation or digits", () => {
    expect(normalizeForComparison("€50")).not.toBe(normalizeForComparison("€60"));
  });
});

describe("classifyExtractedTextFields", () => {
  it("classifies a full extraction result field by field", () => {
    const extracted: ExtractedBusinessDNA = {
      displayName: "Fruppi Toys", // SAME
      industry: "Handicrafts", // CONFLICT (current: "Toys")
      brandTone: "Playful", // NEW (current: "")
      currency: "EUR", // SAME
    };
    const result = classifyExtractedTextFields(currentFields(), extracted);
    expect(result.displayName.classification).toBe("SAME");
    expect(result.industry.classification).toBe("CONFLICT");
    expect(result.brandTone.classification).toBe("NEW");
    expect(result.currency.classification).toBe("SAME");
    // Untouched by the extraction, current value present -> SAME
    expect(result.description.classification).toBe("SAME");
    // Untouched, current empty, non-important -> SAME (no warning)
    expect(result.targetCustomer.classification).toBe("SAME");
  });

  it("joins keyFacts the same way mergeExtractedTextFields does before comparing", () => {
    const result = classifyExtractedTextFields(currentFields({ keyFacts: "Fact A\nFact B" }), {
      keyFacts: ["Fact A", "Fact B"],
    });
    expect(result.keyFacts.classification).toBe("SAME");
  });

  it("flags every important field with no current value and no extraction as MISSING", () => {
    const result = classifyExtractedTextFields(
      currentFields({ displayName: "", description: "", productsServices: "", currency: "" }),
      {},
    );
    expect(result.displayName.classification).toBe("MISSING");
    expect(result.description.classification).toBe("MISSING");
    expect(result.productsServices.classification).toBe("MISSING");
    expect(result.currency.classification).toBe("MISSING");
  });
});

describe("applyAutoAcceptedFields", () => {
  // 7. accepting website value updates form state (the NEW case is
  // auto-accepted; explicit acceptance of a CONFLICT is exercised at the
  // component level in business-dna-form-render.test.tsx)
  it("applies only NEW fields, leaving SAME/CONFLICT/MISSING untouched", () => {
    const current = currentFields({ brandTone: "", industry: "Toys" });
    const classifications = classifyExtractedTextFields(current, {
      brandTone: "Playful and warm", // NEW
      industry: "Handicrafts", // CONFLICT
      displayName: "Fruppi Toys", // SAME
    });
    const result = applyAutoAcceptedFields(current, classifications);
    expect(result.brandTone).toBe("Playful and warm");
    // 8. keeping current value preserves existing form state — a CONFLICT
    // is never auto-applied, regardless of what the extraction found.
    expect(result.industry).toBe("Toys");
    expect(result.displayName).toBe(current.displayName);
  });

  it("does not mutate fields the extraction didn't touch", () => {
    const current = currentFields();
    const classifications = classifyExtractedTextFields(current, {});
    const result = applyAutoAcceptedFields(current, classifications);
    expect(result).toEqual(current);
  });
});

describe("classifySupportedLocales", () => {
  it("classifies an identical set (any order) as SAME", () => {
    expect(classifySupportedLocales(["FI", "EN"], ["EN", "FI"]).classification).toBe("SAME");
  });

  it("classifies an empty current list with a found extraction as NEW", () => {
    expect(classifySupportedLocales([], ["FI", "EN"]).classification).toBe("NEW");
  });

  it("classifies a differing non-empty set as CONFLICT", () => {
    expect(classifySupportedLocales(["FI"], ["EN", "AR"]).classification).toBe("CONFLICT");
  });

  it("classifies a missing/empty extraction as SAME regardless of current", () => {
    expect(classifySupportedLocales(["FI"], undefined).classification).toBe("SAME");
    expect(classifySupportedLocales(["FI"], []).classification).toBe("SAME");
  });
});

describe("resolveFieldConflict", () => {
  const current = currentFields({ industry: "Toys" });
  const conflictReview = classifyTextField("industry", current.industry, "Handicrafts");

  // 7. accepting website value updates form state
  it("replaces the field with the website value when the user chooses 'use website'", () => {
    const result = resolveFieldConflict(current, "industry", conflictReview, true);
    expect(result.industry).toBe("Handicrafts");
    // Nothing else in the form state is touched by resolving one field.
    expect(result.displayName).toBe(current.displayName);
  });

  // 8. keeping current value preserves existing form state
  it("returns the form state completely unchanged when the user chooses 'keep current'", () => {
    const result = resolveFieldConflict(current, "industry", conflictReview, false);
    expect(result).toEqual(current);
  });

  it("does nothing if the review has no extracted value (defensive — should not normally be reachable)", () => {
    const missingReview = classifyTextField("industry", "", undefined);
    const result = resolveFieldConflict(
      currentFields({ industry: "" }),
      "industry",
      missingReview,
      true,
    );
    expect(result.industry).toBe("");
  });
});
