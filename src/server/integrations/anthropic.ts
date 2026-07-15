import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/env";
import { abortableDelay, isTransientAiError, retryDelayMs } from "@/server/ai/retry";

let anthropicClient: Anthropic | null = null;

function getAnthropic(): Anthropic {
  anthropicClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
  return anthropicClient;
}

export const anthropic = new Proxy({} as Anthropic, {
  get(_target, prop: keyof Anthropic) {
    const client = getAnthropic();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type StreamCallbacks = {
  onText: (delta: string) => void | Promise<void>;
  onToolUse?: (name: string, input: unknown, id: string) => Promise<string>;
};

/**
 * Streaming completion with tool-use loop. Providers are wrapped behind this
 * uniform signature so the model router (§15.2) can fail over to OpenAI.
 */
export async function streamClaude(params: {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  tools?: Anthropic.Tool[];
  callbacks: StreamCallbacks;
  signal?: AbortSignal;
}): Promise<{ tokensIn: number; tokensOut: number; stopReason: string | null }> {
  let tokensIn = 0;
  let tokensOut = 0;
  let stopReason: string | null = null;

  const messages: Anthropic.MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Tool-use loop: max 5 rounds to bound cost (§15.6)
  for (let round = 0; round < 5; round++) {
    let final: Anthropic.Message | null = null;
    for (let attempt = 1; attempt <= env.AI_RETRY_MAX_ATTEMPTS; attempt++) {
      let emittedText = false;
      try {
        const stream = getAnthropic().messages.stream(
          {
            model: params.model,
            system: params.system,
            messages,
            max_tokens: params.maxTokens,
            ...(params.tools?.length ? { tools: params.tools } : {}),
          },
          { signal: params.signal },
        );
        stream.on("text", (delta) => {
          emittedText = true;
          void params.callbacks.onText(delta);
        });
        final = await stream.finalMessage();
        break;
      } catch (error) {
        if (emittedText || attempt === env.AI_RETRY_MAX_ATTEMPTS || !isTransientAiError(error)) {
          throw error;
        }
        await abortableDelay(retryDelayMs(attempt, env.AI_RETRY_BASE_DELAY_MS), params.signal);
      }
    }
    if (!final) throw new Error("AI provider returned no response");
    tokensIn += final.usage.input_tokens;
    tokensOut += final.usage.output_tokens;
    stopReason = final.stop_reason;

    if (final.stop_reason !== "tool_use" || !params.callbacks.onToolUse) {
      return { tokensIn, tokensOut, stopReason };
    }

    // Execute requested tools and continue the loop
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type === "tool_use") {
        const result = await params.callbacks.onToolUse(block.name, block.input, block.id);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }
    messages.push({ role: "assistant", content: final.content });
    messages.push({ role: "user", content: toolResults });
  }

  return { tokensIn, tokensOut, stopReason: "max_tool_rounds" };
}
