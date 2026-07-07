import { z } from "zod";

export const contactSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).optional().or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(30).optional().or(z.literal("")),
  title: z.string().max(120).optional().or(z.literal("")),
  companyId: z.string().uuid().optional(),
  status: z.enum(["LEAD", "PROSPECT", "CUSTOMER", "CHURNED", "ARCHIVED"]).default("LEAD"),
  gdprConsent: z.coerce.boolean().default(false),
});

export const contactListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["LEAD", "PROSPECT", "CUSTOMER", "CHURNED", "ARCHIVED"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
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
export type DealInput = z.infer<typeof dealSchema>;
