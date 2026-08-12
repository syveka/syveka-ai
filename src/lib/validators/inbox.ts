import { z } from "zod";

export const INBOX_CHANNELS = ["EMAIL", "SMS", "WHATSAPP", "WEB_CHAT"] as const;
export const INBOX_THREAD_STATUSES = ["OPEN", "PENDING", "CLOSED"] as const;

/** "" (empty form field) → undefined; otherwise trimmed string. */
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalUuid = z
  .string()
  .uuid()
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : undefined));

/** Simulates a message arriving on a channel — normally called by a future
 * webhook, not directly by a user. Finds or creates the matching thread. */
export const recordInboundMessageSchema = z.object({
  channel: z.enum(INBOX_CHANNELS),
  contactId: optionalUuid,
  fromAddress: optionalTrimmed(320),
  toAddress: optionalTrimmed(320),
  subject: optionalTrimmed(200),
  body: z.string().trim().min(1).max(10_000),
  externalId: optionalTrimmed(200),
});
export type RecordInboundMessageInput = z.infer<typeof recordInboundMessageSchema>;

/**
 * Normalized inbound-email webhook payload — deliberately provider-agnostic
 * (not any specific ESP's raw webhook JSON shape; see
 * `src/server/channels/email/resend-inbound.ts` for the real Resend
 * adapter, which normalizes into this same shape before it reaches the
 * service layer). `toAddress` is required and is the ONLY signal used to
 * resolve the organization — via a server-controlled mailbox lookup, never
 * trusted directly. There is deliberately no `organizationId` field: a
 * caller can never simply assert which tenant a message belongs to.
 */
export const inboundEmailWebhookSchema = z.object({
  toAddress: z.string().trim().min(1).max(320),
  fromAddress: z.string().trim().min(1).max(320),
  subject: optionalTrimmed(200),
  body: z.string().trim().min(1).max(10_000),
  externalId: optionalTrimmed(200),
});
export type InboundEmailWebhookInput = z.infer<typeof inboundEmailWebhookSchema>;

export const createDraftMessageSchema = z.object({
  threadId: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
  aiGenerated: z.coerce.boolean().default(false),
});
export type CreateDraftMessageInput = z.infer<typeof createDraftMessageSchema>;

export const editDraftMessageSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});
export type EditDraftMessageInput = z.infer<typeof editDraftMessageSchema>;

export const threadListQuerySchema = z.object({
  status: z.enum(INBOX_THREAD_STATUSES).optional(),
  channel: z.enum(INBOX_CHANNELS).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const updateThreadStatusSchema = z.object({
  status: z.enum(INBOX_THREAD_STATUSES),
});
export type UpdateThreadStatusInput = z.infer<typeof updateThreadStatusSchema>;

export const assignThreadSchema = z.object({
  assignedToId: optionalUuid,
});
export type AssignThreadInput = z.infer<typeof assignThreadSchema>;

export const createContactFromThreadSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: optionalTrimmed(100),
});
export type CreateContactFromThreadInput = z.infer<typeof createContactFromThreadSchema>;
