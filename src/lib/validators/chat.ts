import { z } from "zod";

export const chatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(8_000),
  useKnowledgeBase: z.boolean().default(true),
  deepMode: z.boolean().default(false),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** SSE event contract shared by the route and the client hook. */
export type ChatStreamEvent =
  | { type: "meta"; conversationId: string; messageId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" }
  | { type: "citations"; citations: Array<{ documentId: string; title: string }> }
  | { type: "done"; tokensIn: number; tokensOut: number }
  | { type: "error"; code: string };
