import { z } from "zod";

export const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().min(1).max(8_000),
    useKnowledgeBase: z.boolean().default(true),
    deepMode: z.boolean().default(false),
    documentIds: z.array(z.string().uuid()).max(10).default([]),
    /**
     * "voice" = a turn of a live voice conversation: a short, speakable reply
     * and read-only tools (no record changes, bookings or messages), because
     * an automatically submitted spoken turn is not a confirmation.
     */
    responseMode: z.enum(["text", "voice"]).default("text"),
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
export type ChatStreamEvent =
  | { type: "meta"; conversationId: string; messageId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" }
  | { type: "citations"; citations: Array<{ documentId: string; title: string }> }
  | { type: "done"; tokensIn: number; tokensOut: number; estimatedCostUsd: number }
  | { type: "error"; code: string };
