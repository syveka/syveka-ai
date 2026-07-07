import { z } from "zod";

export const createOrgSchema = z.object({
  name: z.string().min(2).max(120),
  businessId: z
    .string()
    .regex(/^\d{7}-\d$/, "Invalid Y-tunnus (format: 1234567-8)")
    .optional()
    .or(z.literal("")),
  industry: z.string().max(120).optional(),
  defaultLocale: z.enum(["FI", "EN", "AR"]).default("FI"),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;
