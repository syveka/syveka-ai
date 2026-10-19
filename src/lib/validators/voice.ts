import { z } from "zod";

// Tools a phone assistant may run on behalf of an anonymous caller. Deliberately absent:
// - searchContacts: it returns any contact's name, email and phone to whoever dials in;
// - searchKnowledgeBase: it searches every document in the organization, and nothing
//   marks a document as approved for the public. An assistant's useKnowledgeBase
//   setting is not that approval: it defaulted to on. Assistants that stored it are
//   refused it by allowedVoiceTools below.
export const VOICE_TOOL_NAMES = [
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
] as const;

/** Strict E.164: + then 1-15 digits, first digit 1-9 (ITU-T E.164 §6.1). */
const e164 = z.string().regex(/^\+[1-9]\d{1,14}$/, "invalid_e164");
const optionalFormattedE164 = z
  .string()
  .max(30)
  .transform((value) => value.replace(/[\s().-]/g, ""))
  .refine((value) => value === "" || /^\+[1-9]\d{1,14}$/.test(value), "invalid_e164");

export const voiceAssistantSchema = z.object({
  name: z.string().min(1).max(100),
  language: z.enum(["FI", "EN", "AR"]).default("FI"),
  voiceProvider: z.enum(["azure", "elevenlabs"]).default("azure"),
  voiceId: z.string().max(100).optional().or(z.literal("")),
  firstMessage: z.string().min(1).max(500),
  systemPrompt: z.string().min(10).max(8000),
  enabledTools: z.array(z.enum(VOICE_TOOL_NAMES)).default([]),
  // Kept for stored assistants; it no longer gives phone callers knowledge-base access.
  useKnowledgeBase: z.boolean().default(false),
  // Accept the human-friendly format the UI historically suggested, but
  // persist and send only canonical E.164 to Vapi's transferCall tool.
  transferNumber: optionalFormattedE164.optional(),
});

export type VoiceAssistantInput = z.infer<typeof voiceAssistantSchema>;

/**
 * The canonical E.164 number given to Vapi's transferCall tool for a stored transfer
 * number, or null when none is stored or it isn't valid. Existing rows predate strict
 * validation and may use the UI's former human-friendly formatting. Null means the call
 * has no transfer tool, so the assistant must not offer a transfer.
 */
export function transferCallNumber(stored: string | null | undefined): string | null {
  const number = stored?.replace(/[\s().-]/g, "");
  return number && /^\+[1-9]\d{1,14}$/.test(number) ? number : null;
}

/**
 * The tools a stored assistant may actually run: what is offered to Vapi and what the
 * webhook will execute. Assistants saved before a tool was removed from VOICE_TOOL_NAMES
 * can still list it in their stored enabledTools (or have useKnowledgeBase set); it is
 * dropped here.
 */
export function allowedVoiceTools(enabledTools: unknown): string[] {
  const stored = Array.isArray(enabledTools) ? enabledTools : [];
  const allowed: readonly string[] = VOICE_TOOL_NAMES;
  return [
    ...new Set(stored.filter((t): t is string => typeof t === "string" && allowed.includes(t))),
  ];
}

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
