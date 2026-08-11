import { z } from "zod";

/** "" (empty form field) → undefined; otherwise trimmed string. */
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : undefined));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const weekdayHoursSchema = z
  .object({
    closed: z.coerce.boolean().default(false),
    open: z.string().regex(HHMM, "invalid time").optional(),
    close: z.string().regex(HHMM, "invalid time").optional(),
  })
  .refine((v) => v.closed || (v.open && v.close), {
    message: "open and close are required unless closed is true",
  });

export const openingHoursSchema = z
  .object({
    monday: weekdayHoursSchema.optional(),
    tuesday: weekdayHoursSchema.optional(),
    wednesday: weekdayHoursSchema.optional(),
    thursday: weekdayHoursSchema.optional(),
    friday: weekdayHoursSchema.optional(),
    saturday: weekdayHoursSchema.optional(),
    sunday: weekdayHoursSchema.optional(),
  })
  .strict();

export const BUSINESS_DNA_LOCALES = ["FI", "EN", "AR"] as const;

const keyFactsSchema = z.array(z.string().trim().min(1).max(300)).max(20).default([]);

/** Manual form input (create/update). Provenance fields are server-set only. */
export const businessDnaSchema = z.object({
  displayName: optionalTrimmed(200),
  industry: optionalTrimmed(120),
  productsServices: optionalTrimmed(4000),
  supportedLocales: z
    .array(z.enum(BUSINESS_DNA_LOCALES))
    .max(BUSINESS_DNA_LOCALES.length)
    .default([]),
  brandTone: optionalTrimmed(200),
  communicationStyle: optionalTrimmed(200),
  openingHours: openingHoursSchema.nullish(),
  policies: optionalTrimmed(4000),
  pricingNotes: optionalTrimmed(4000),
  targetCustomer: optionalTrimmed(2000),
  keyFacts: keyFactsSchema,
  /** Provenance only — never raw scraped content. Presence re-stamps extractedAt. */
  sourceUrl: optionalUrl,
});

export type BusinessDNAInput = z.infer<typeof businessDnaSchema>;
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/** AI-extraction output: same shape as the form, but every field is optional
 * (a scrape may only surface a handful of facts) and nothing is defaulted. */
export const extractedBusinessDnaSchema = z.object({
  displayName: optionalTrimmed(200),
  industry: optionalTrimmed(120),
  productsServices: optionalTrimmed(4000),
  supportedLocales: z
    .array(z.enum(BUSINESS_DNA_LOCALES))
    .max(BUSINESS_DNA_LOCALES.length)
    .optional(),
  brandTone: optionalTrimmed(200),
  communicationStyle: optionalTrimmed(200),
  openingHours: openingHoursSchema.nullish(),
  policies: optionalTrimmed(4000),
  pricingNotes: optionalTrimmed(4000),
  targetCustomer: optionalTrimmed(2000),
  keyFacts: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
});

export type ExtractedBusinessDNA = z.infer<typeof extractedBusinessDnaSchema>;

export const extractBusinessDnaRequestSchema = z.object({
  url: z.string().trim().url().max(2048),
});
