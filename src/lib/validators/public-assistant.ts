import { z } from "zod";
import { APP_LOCALES } from "@/i18n/locales";

/**
 * Public marketing-site assistant request (src/app/api/v1/public-assistant).
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
      .default([])
      // Anthropic's Messages API requires strictly alternating turns starting
      // with "user" -- rejecting a malformed sequence here, before any
      // provider call, means a caller that doesn't go through the real
      // widget (this is a public, unauthenticated endpoint anyone can POST
      // to directly) can't burn a rate-limit slot and a moderation call on a
      // request that was always going to fail at the provider anyway.
      .refine(
        (history) => history.every((turn, i) => turn.role === (i % 2 === 0 ? "user" : "assistant")),
        { message: 'history must alternate starting with "user"' },
      ),
  })
  .strict();

export type PublicAssistantRequest = z.infer<typeof publicAssistantRequestSchema>;
