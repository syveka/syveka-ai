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
