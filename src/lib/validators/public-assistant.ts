import { z } from "zod";
import { APP_LOCALES } from "@/i18n/locales";

/**
 * Public marketing-site assistant request (src/app/api/v1/public/assistant).
 * Unauthenticated and public -- deliberately far tighter than the in-app
 * chatRequestSchema (src/lib/validators/chat.ts): a short message, a short
 * client-held history (never persisted server-side), no documents, no tools.
 */
export const publicAssistantRequestSchema = z
  .object({
    message: z.string().min(1).max(600),
    locale: z.enum(APP_LOCALES).default("en"),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1).max(600),
        }),
      )
      .max(8)
      .default([]),
  })
  .strict();

export type PublicAssistantRequest = z.infer<typeof publicAssistantRequestSchema>;
