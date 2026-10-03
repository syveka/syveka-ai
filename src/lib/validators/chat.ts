import { z } from "zod";

export const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().min(1).max(8_000),
    useKnowledgeBase: z.boolean().default(true),
    deepMode: z.boolean().default(false),
    documentIds: z.array(z.string().uuid()).max(10).default([]),
    /**
     * Single-use grant issued by POST /api/v1/ai/voice-conversation/turn for
     * one live voice turn. The server derives voice mode (read-only tools,
     * bounded reply) from a valid grant — there is no client-controlled mode.
     */
    voiceGrant: z.string().uuid().optional(),
  })
  .strict();

export const chatFileFinalizeSchema = z
  .object({
    title: z.string().min(1).max(200),
    uploadIntentId: z.string().uuid(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** SSE event contract shared by the route and the client hook. */
/**
 * A pending AI write action as the client shows it (see
 * src/server/ai/tool-actions.ts). Details are structured fields, rendered
 * and localized by the client; the model's text is never the confirmation.
 */
export type ProposedActionView = {
  id: string;
  tool: string;
  digest: string;
  conversationId: string;
  expiresAt: number;
  details:
    | {
        tool: "createContact";
        firstName: string;
        lastName?: string;
        email?: string;
        phone?: string;
      }
    | {
        tool: "logActivity";
        type: "NOTE" | "TASK";
        subject: string;
        contactName: string;
        dueAt?: string;
        /** The activity's text, shown in full: the user confirms exactly what is saved. */
        body?: string;
      }
    | {
        tool: "bookMeeting";
        title: string;
        startsAt: string;
        durationMinutes: number;
        timezone: string;
        contactName?: string;
        /** The event description, shown in full. */
        notes?: string;
      };
};

/**
 * The recorded outcome of a saved action, shown when a conversation is
 * opened again (see src/server/ai/tool-action-history.ts). "unavailable":
 * it expired without a recorded result; nothing is inferred.
 */
export type RestoredActionState =
  | "done"
  | "canceled"
  | "slotTaken"
  | "failed"
  /** Decided, but the result can't be established (e.g. its record failed). Not executable. */
  | "unknown"
  | "unavailable";

export type ChatStreamEvent =
  | { type: "meta"; conversationId: string; messageId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" }
  | { type: "citations"; citations: Array<{ documentId: string; title: string }> }
  /** A write the model proposed; nothing happens until the user confirms it. */
  | { type: "action"; action: ProposedActionView }
  | { type: "done"; tokensIn: number; tokensOut: number; estimatedCostUsd: number }
  | { type: "error"; code: string };
