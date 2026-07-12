import { z } from "zod";

export const CONTACT_STATUSES = ["LEAD", "PROSPECT", "CUSTOMER", "CHURNED", "ARCHIVED"] as const;

/** "" (empty form field) → undefined; otherwise trimmed string. */
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalEmail = z
  .string()
  .trim()
  .email()
  .max(320)
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalUrl = z
  .string()
  .trim()
  .url()
  .max(300)
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalUuid = z
  .string()
  .uuid()
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : undefined));

/** List filter for soft-archived records. */
export const archivedFilterSchema = z.enum(["active", "archived", "all"]).default("active");
export type ArchivedFilter = z.infer<typeof archivedFilterSchema>;

export const contactSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: optionalTrimmed(100),
  email: optionalEmail,
  phone: optionalTrimmed(30),
  title: optionalTrimmed(120),
  companyId: optionalUuid,
  status: z.enum(CONTACT_STATUSES).default("LEAD"),
  gdprConsent: z.coerce.boolean().default(false),
});

export const contactListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  companyId: z.string().uuid().optional(),
  archived: archivedFilterSchema,
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const companySchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: optionalTrimmed(200),
  industry: optionalTrimmed(120),
  size: optionalTrimmed(50),
  website: optionalUrl,
  businessId: optionalTrimmed(50),
});

export const companyListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  archived: archivedFilterSchema,
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const noteSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const DEAL_CURRENCIES = ["EUR", "USD", "GBP", "SEK", "NOK", "DKK"] as const;

/** "" (empty form field) → undefined so `.optional()` kicks in before coercion. */
const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/** Optional 0–100 integer; empty form fields mean "inherit from stage". */
const optionalProbability = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(0).max(100).optional(),
);

/** Optional ISO date (yyyy-mm-dd) or datetime-local string from a form. */
const optionalDateString = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .max(30)
    .refine((v) => !Number.isNaN(new Date(v).getTime()), "invalid date")
    .optional(),
);

export const dealSchema = z.object({
  title: z.string().trim().min(1).max(200),
  valueCents: z.coerce.number().int().min(0).max(9_000_000_000).default(0),
  currency: z.enum(DEAL_CURRENCIES).default("EUR"),
  probability: optionalProbability,
  contactId: optionalUuid,
  companyId: optionalUuid,
  ownerId: optionalUuid,
  stageId: z.string().uuid(),
  expectedCloseAt: optionalDateString,
});

export const moveDealSchema = z.object({
  dealId: z.string().uuid(),
  stageId: z.string().uuid(),
  position: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const dealTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: optionalDateString,
});

export const pipelineStageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  probability: z.coerce.number().int().min(0).max(100).default(0),
  kind: z.enum(["open", "won", "lost"]).default("open"),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type DealInput = z.infer<typeof dealSchema>;
export type MoveDealInput = z.infer<typeof moveDealSchema>;
export type DealTaskInput = z.infer<typeof dealTaskSchema>;
export type PipelineStageInput = z.infer<typeof pipelineStageSchema>;
