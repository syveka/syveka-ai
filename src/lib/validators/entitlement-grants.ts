import { z } from "zod";

const ENTITLEMENT_METRICS = [
  "MAX_SEATS",
  "AI_MESSAGES_PER_USER_MONTH",
  "VOICE_ASSISTANTS",
  "VOICE_MINUTES_MONTH",
  "KB_STORAGE_MB",
  "ACTIVE_WORKFLOWS",
  "MAX_CONTACTS",
  "AUDIT_RETENTION_DAYS",
  "CREATOR_CREDITS_PER_MONTH",
] as const;

export const createEntitlementGrantSchema = z.object({
  organizationId: z.string().uuid(),
  metric: z.enum(ENTITLEMENT_METRICS),
  amount: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  // Plain "" from an optional <input type="date"> means "no expiry".
  expiresAt: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Invalid date"),
});

export const revokeEntitlementGrantSchema = z.object({
  grantId: z.string().uuid(),
  organizationId: z.string().uuid(),
});
