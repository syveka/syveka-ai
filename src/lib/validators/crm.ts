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

export const dealSchema = z.object({
  title: z.string().min(1).max(200),
  valueCents: z.coerce.number().int().min(0).default(0),
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  stageId: z.string().uuid(),
  expectedCloseAt: z.string().optional(),
});

export const moveDealSchema = z.object({
  dealId: z.string().uuid(),
  stageId: z.string().uuid(),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type DealInput = z.infer<typeof dealSchema>;
