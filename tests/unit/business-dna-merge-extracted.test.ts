import { describe, expect, it } from "vitest";
import {
  mergeExtractedOpeningHours,
  mergeExtractedSupportedLocales,
  mergeExtractedTextFields,
  type BusinessDnaTextFields,
} from "@/lib/business-dna/merge-extracted";
import { DEFAULT_DAY_HOURS, normalizeOpeningHours } from "@/lib/business-dna/opening-hours";
import type { ExtractedBusinessDNA } from "@/lib/validators/business-dna";

function currentFields(overrides: Partial<BusinessDnaTextFields> = {}): BusinessDnaTextFields {
  return {
    displayName: "Existing Name",
    industry: "Existing Industry",
    description: "Existing Description",
    brandTone: "Existing Tone",
    communicationStyle: "Existing Style",
    responseInstructions: "Existing Response Instructions",
    productsServices: "Existing Products",
    targetCustomer: "Existing Customer",
    timezone: "Europe/Helsinki",
    cancellationPolicy: "Existing Cancellation",
    bookingPolicy: "Existing Booking",
    refundPolicy: "Existing Refund",
    paymentPolicy: "Existing Payment",
    otherPolicies: "Existing Policies",
    currency: "EUR",
    quoteInstructions: "Existing Quote Instructions",
    pricingNotes: "Existing Pricing",
    keyFacts: "Existing fact 1\nExisting fact 2",
    ...overrides,
  };
}

describe("mergeExtractedTextFields", () => {
  it("overwrites only the fields the extraction returned", () => {
    const extracted: ExtractedBusinessDNA = {
      displayName: "New Name",
      industry: undefined,
    };
    const result = mergeExtractedTextFields(currentFields(), extracted);
    expect(result.displayName).toBe("New Name");
    expect(result.industry).toBe("Existing Industry");
    expect(result.brandTone).toBe("Existing Tone");
  });

  it("never fabricates a value for a field the extraction omitted entirely", () => {
    const result = mergeExtractedTextFields(currentFields(), {});
    expect(result).toEqual(currentFields());
  });

  it("joins extracted keyFacts with newlines, matching the textarea format", () => {
    const result = mergeExtractedTextFields(currentFields(), {
      keyFacts: ["Fact A", "Fact B", "Fact C"],
    });
    expect(result.keyFacts).toBe("Fact A\nFact B\nFact C");
  });

  it("leaves keyFacts untouched when the extraction returns an empty array", () => {
    const result = mergeExtractedTextFields(currentFields(), { keyFacts: [] });
    expect(result.keyFacts).toBe("Existing fact 1\nExisting fact 2");
  });

  it("overwrites every text field when the extraction returns all of them", () => {
    const extracted: ExtractedBusinessDNA = {
      displayName: "A",
      industry: "B",
      description: "B2",
      brandTone: "C",
      communicationStyle: "D",
      responseInstructions: "D2",
      productsServices: "E",
      targetCustomer: "F",
      timezone: "America/New_York",
      cancellationPolicy: "F1",
      bookingPolicy: "F2",
      refundPolicy: "F3",
      paymentPolicy: "F4",
      otherPolicies: "G",
      currency: "USD",
      quoteInstructions: "G2",
      pricingNotes: "H",
      keyFacts: ["I"],
    };
    const result = mergeExtractedTextFields(currentFields(), extracted);
    expect(result).toEqual({
      displayName: "A",
      industry: "B",
      description: "B2",
      brandTone: "C",
      communicationStyle: "D",
      responseInstructions: "D2",
      productsServices: "E",
      targetCustomer: "F",
      timezone: "America/New_York",
      cancellationPolicy: "F1",
      bookingPolicy: "F2",
      refundPolicy: "F3",
      paymentPolicy: "F4",
      otherPolicies: "G",
      currency: "USD",
      quoteInstructions: "G2",
      pricingNotes: "H",
      keyFacts: "I",
    });
  });
});

describe("mergeExtractedSupportedLocales", () => {
  it("replaces the current list when the extraction returns locales", () => {
    expect(mergeExtractedSupportedLocales(["EN"], { supportedLocales: ["FI", "AR"] })).toEqual([
      "FI",
      "AR",
    ]);
  });

  it("keeps the current list when the extraction omits supportedLocales", () => {
    expect(mergeExtractedSupportedLocales(["EN"], {})).toEqual(["EN"]);
  });

  it("keeps the current list when the extraction returns an empty array", () => {
    expect(mergeExtractedSupportedLocales(["EN"], { supportedLocales: [] })).toEqual(["EN"]);
  });
});

describe("mergeExtractedOpeningHours", () => {
  const current = normalizeOpeningHours({
    monday: { closed: false, open: "08:00", close: "16:00" },
  });

  it("normalizes and applies extracted opening hours", () => {
    const result = mergeExtractedOpeningHours(current, {
      openingHours: { tuesday: { closed: false, open: "09:00", close: "18:00" } },
    });
    expect(result.tuesday).toEqual({ closed: false, open: "09:00", close: "18:00" });
    // Days absent from the extracted payload fall back to the normalizer's
    // default rather than carrying over the previous state — the extracted
    // opening hours fully replace the week, they don't merge day-by-day.
    expect(result.monday).toEqual(DEFAULT_DAY_HOURS);
  });

  it("keeps the current hours when the extraction omits openingHours", () => {
    expect(mergeExtractedOpeningHours(current, {})).toEqual(current);
  });

  it("keeps the current hours when the extraction returns null", () => {
    expect(mergeExtractedOpeningHours(current, { openingHours: null })).toEqual(current);
  });
});
