import type { ExtractedBusinessDNA } from "@/lib/validators/business-dna";
import { normalizeOpeningHours, type WeekHours } from "./opening-hours";

export type BusinessDnaTextFields = {
  displayName: string;
  industry: string;
  description: string;
  brandTone: string;
  communicationStyle: string;
  responseInstructions: string;
  productsServices: string;
  targetCustomer: string;
  timezone: string;
  cancellationPolicy: string;
  bookingPolicy: string;
  refundPolicy: string;
  paymentPolicy: string;
  otherPolicies: string;
  currency: string;
  quoteInstructions: string;
  pricingNotes: string;
  keyFacts: string;
};

/**
 * Merges an AI-extraction result into the human-edited form state. Every
 * field in `ExtractedBusinessDNA` is optional (a scrape may only surface a
 * handful of facts) — anything the extraction didn't return leaves the
 * current value untouched rather than clearing it. Deterministic, no
 * fabrication: a field is only ever set to what the extraction literally
 * returned, never inferred or defaulted.
 */
export function mergeExtractedTextFields(
  current: BusinessDnaTextFields,
  extracted: ExtractedBusinessDNA,
): BusinessDnaTextFields {
  return {
    displayName: extracted.displayName ?? current.displayName,
    industry: extracted.industry ?? current.industry,
    description: extracted.description ?? current.description,
    brandTone: extracted.brandTone ?? current.brandTone,
    communicationStyle: extracted.communicationStyle ?? current.communicationStyle,
    responseInstructions: extracted.responseInstructions ?? current.responseInstructions,
    productsServices: extracted.productsServices ?? current.productsServices,
    targetCustomer: extracted.targetCustomer ?? current.targetCustomer,
    timezone: extracted.timezone ?? current.timezone,
    cancellationPolicy: extracted.cancellationPolicy ?? current.cancellationPolicy,
    bookingPolicy: extracted.bookingPolicy ?? current.bookingPolicy,
    refundPolicy: extracted.refundPolicy ?? current.refundPolicy,
    paymentPolicy: extracted.paymentPolicy ?? current.paymentPolicy,
    otherPolicies: extracted.otherPolicies ?? current.otherPolicies,
    currency: extracted.currency ?? current.currency,
    quoteInstructions: extracted.quoteInstructions ?? current.quoteInstructions,
    pricingNotes: extracted.pricingNotes ?? current.pricingNotes,
    keyFacts:
      extracted.keyFacts && extracted.keyFacts.length > 0
        ? extracted.keyFacts.join("\n")
        : current.keyFacts,
  };
}

export function mergeExtractedSupportedLocales(
  current: string[],
  extracted: ExtractedBusinessDNA,
): string[] {
  return extracted.supportedLocales && extracted.supportedLocales.length > 0
    ? extracted.supportedLocales
    : current;
}

export function mergeExtractedOpeningHours(
  current: WeekHours,
  extracted: ExtractedBusinessDNA,
): WeekHours {
  return extracted.openingHours ? normalizeOpeningHours(extracted.openingHours) : current;
}
