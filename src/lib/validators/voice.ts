import { z } from "zod";

export const VOICE_TOOL_NAMES = [
  "searchKnowledgeBase",
  "searchContacts",
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
] as const;

export const voiceAssistantSchema = z.object({
  name: z.string().min(1).max(100),
  language: z.enum(["FI", "EN", "AR"]).default("FI"),
  voiceProvider: z.enum(["azure", "elevenlabs"]).default("azure"),
  voiceId: z.string().max(100).optional().or(z.literal("")),
  firstMessage: z.string().min(1).max(500),
  systemPrompt: z.string().min(10).max(8000),
  enabledTools: z.array(z.enum(VOICE_TOOL_NAMES)).default(["searchKnowledgeBase"]),
  useKnowledgeBase: z.boolean().default(true),
  transferNumber: z.string().max(20).optional().or(z.literal("")),
});

export type VoiceAssistantInput = z.infer<typeof voiceAssistantSchema>;

/** Strict E.164: + then 1-15 digits, first digit 1-9 (ITU-T E.164 §6.1). */
const e164 = z.string().regex(/^\+[1-9]\d{1,14}$/, "invalid_e164");

/**
 * Attach an existing, externally-held number to an already-synced Vapi
 * assistant -- Vapi's native number pool is US/Canada-only, so this is the
 * only path to a real +358 (or any other non-US/CA) number today. Twilio
 * credentials are validated for shape only; they are never persisted (see
 * attachPhoneNumber() in server/services/voice.ts) -- only passed through to
 * Vapi's own import call in-memory for the duration of that one request.
 */
export const attachPhoneNumberSchema = z.object({
  provider: z.enum(["twilio", "byo-phone-number"]),
  phoneNumber: e164,
  twilioAccountSid: z.string().min(1).max(200).optional(),
  twilioAuthToken: z.string().min(1).max(200).optional(),
  sipUri: z.string().min(1).max(500).optional(),
});

export type AttachPhoneNumberInput = z.infer<typeof attachPhoneNumberSchema>;
