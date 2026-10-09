import type { BusinessDnaPatchField } from "@/lib/validators/business-dna-patch";

/**
 * The Business DNA fields that matter most for Syveka's AI features (chat,
 * voice, booking, inbox), most important first. Chat asks about the first
 * missing one, one question at a time, instead of presenting a form.
 */
export const BUSINESS_DNA_IMPORTANT_FIELDS = [
  "displayName",
  "industry",
  "description",
  "productsServices",
  "openingHours",
  "supportedLocales",
  "timezone",
  "targetCustomer",
  "bookingPolicy",
  "cancellationPolicy",
  "paymentPolicy",
  "brandTone",
] as const satisfies readonly BusinessDnaPatchField[];

export type BusinessDnaImportantField = (typeof BUSINESS_DNA_IMPORTANT_FIELDS)[number];

type ProfileValues = Partial<Record<BusinessDnaImportantField, unknown>>;

function hasOpeningHours(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some(
    (day) =>
      !!day &&
      typeof day === "object" &&
      ((day as { closed?: unknown }).closed === true ||
        (typeof (day as { open?: unknown }).open === "string" &&
          typeof (day as { close?: unknown }).close === "string")),
  );
}

function isFilled(field: BusinessDnaImportantField, value: unknown): boolean {
  if (field === "openingHours") return hasOpeningHours(value);
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The important fields that are still empty, most important first. Active
 * structured services count as describing what the business offers.
 */
export function missingBusinessDnaFields(
  profile: ProfileValues | null | undefined,
  options: { activeServiceCount?: number } = {},
): BusinessDnaImportantField[] {
  return BUSINESS_DNA_IMPORTANT_FIELDS.filter((field) => {
    if (field === "productsServices" && (options.activeServiceCount ?? 0) > 0) return false;
    return !isFilled(field, profile?.[field]);
  });
}
