import { z } from "zod";
import { BUSINESS_DNA_LOCALES } from "@/lib/validators/business-dna";

/**
 * A partial change to an organization's Business DNA profile, proposed from
 * chat (see src/server/services/business-dna-patch.ts).
 *
 * Only these profile fields can be changed this way. Provenance (sourceUrl,
 * extractedAt), identity (id, organizationId) and timestamps are never
 * patchable; services have their own CRUD surface.
 *
 * The fields that instruct the AI itself (BUSINESS_DNA_SETTINGS_ONLY_FIELDS)
 * are changed only in the Business DNA settings: they shape every later
 * chat and voice reply, so a proposal steered by content the model read
 * (e.g. a knowledge-base document) must never be able to change them.
 */
export const BUSINESS_DNA_SETTINGS_ONLY_FIELDS = [
  "communicationStyle",
  "responseInstructions",
] as const;

export const BUSINESS_DNA_PATCH_FIELDS = [
  "displayName",
  "industry",
  "description",
  "productsServices",
  "supportedLocales",
  "timezone",
  "brandTone",
  "openingHours",
  "cancellationPolicy",
  "bookingPolicy",
  "refundPolicy",
  "paymentPolicy",
  "otherPolicies",
  "currency",
  "quoteInstructions",
  "pricingNotes",
  "targetCustomer",
  "keyFacts",
] as const;

export type BusinessDnaPatchField = (typeof BUSINESS_DNA_PATCH_FIELDS)[number];

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (max: number) => z.string().trim().min(1).max(max);

const dayHoursSchema = z
  .object({
    closed: z.boolean().optional(),
    open: z.string().regex(HHMM, "invalid time").optional(),
    close: z.string().regex(HHMM, "invalid time").optional(),
  })
  .strict()
  .refine((v) => (v.closed ? !v.open && !v.close : !!v.open && !!v.close && v.open !== v.close), {
    message: "a day is either closed, or has different opening and closing times",
  });

/** Opening hours for the days being changed; days left out keep their current hours. */
const openingHoursPatchSchema = z
  .object(Object.fromEntries(WEEKDAYS.map((d) => [d, dayHoursSchema.optional()])))
  .strict()
  .refine((v) => Object.values(v).some(Boolean), { message: "no days given" });

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid IANA timezone" },
  );

/**
 * New values for the fields being set. Same limits as the Business DNA form
 * (businessDnaSchema), so chat can't store anything the form couldn't.
 * Lists (supportedLocales, keyFacts) are the complete new list.
 */
const setSchema = z
  .object({
    displayName: text(200),
    industry: text(120),
    description: text(1000),
    productsServices: text(4000),
    supportedLocales: z.array(z.enum(BUSINESS_DNA_LOCALES)).min(1).max(BUSINESS_DNA_LOCALES.length),
    timezone: timezoneSchema,
    brandTone: text(200),
    openingHours: openingHoursPatchSchema,
    cancellationPolicy: text(2000),
    bookingPolicy: text(2000),
    refundPolicy: text(2000),
    paymentPolicy: text(2000),
    otherPolicies: text(4000),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO 4217 code")
      .transform((v) => v.toUpperCase()),
    quoteInstructions: text(2000),
    pricingNotes: text(4000),
    targetCustomer: text(2000),
    keyFacts: z.array(text(300)).min(1).max(20),
  })
  .partial()
  .strict();

export const businessDnaPatchSchema = z
  .object({
    /** Fields to add or change, with their new values. */
    set: setSchema.optional(),
    /** Fields to remove (cleared to empty). */
    clear: z
      .array(z.enum(BUSINESS_DNA_PATCH_FIELDS))
      .max(BUSINESS_DNA_PATCH_FIELDS.length)
      .optional(),
  })
  .strict()
  .superRefine((patch, issue) => {
    const setFields = Object.keys(patch.set ?? {});
    const clearFields = patch.clear ?? [];
    if (setFields.length === 0 && clearFields.length === 0) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "no changes" });
    }
    for (const field of clearFields) {
      if (setFields.includes(field)) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clear"],
          message: `${field} is both set and cleared`,
        });
      }
    }
    if (new Set(clearFields).size !== clearFields.length) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"], message: "duplicate field" });
    }
  });

export type BusinessDnaPatch = z.infer<typeof businessDnaPatchSchema>;
export type OpeningHoursPatch = NonNullable<NonNullable<BusinessDnaPatch["set"]>["openingHours"]>;

/**
 * The confirmed form of a patch: the patch plus the values its fields had
 * when the user was shown the change. It is applied only while those fields
 * still have those values (see applyBusinessDnaPatch).
 */
export const confirmedBusinessDnaPatchSchema = z
  .object({
    set: setSchema.optional(),
    clear: z
      .array(z.enum(BUSINESS_DNA_PATCH_FIELDS))
      .max(BUSINESS_DNA_PATCH_FIELDS.length)
      .optional(),
    basis: z
      .object({
        exists: z.boolean(),
        fields: z.record(z.enum(BUSINESS_DNA_PATCH_FIELDS), z.unknown()),
      })
      .strict(),
  })
  .strict();

export type ConfirmedBusinessDnaPatch = z.infer<typeof confirmedBusinessDnaPatchSchema>;

/** How a changed value is shown to the user (rendered and localized by the client). */
export type BusinessDnaDisplayValue =
  | { type: "text"; value: string }
  | { type: "list"; items: string[] }
  | {
      type: "hours";
      days: Array<{ day: Weekday; closed: boolean; open?: string; close?: string }>;
    };

export type BusinessDnaChange = {
  field: BusinessDnaPatchField;
  kind: "added" | "modified" | "removed";
  before: BusinessDnaDisplayValue | null;
  after: BusinessDnaDisplayValue | null;
};
