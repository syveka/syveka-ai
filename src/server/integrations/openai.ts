import "server-only";

import OpenAI, { toFile } from "openai";
import { getOpenAIEnv } from "@/env";
import { withAiRetry } from "@/server/ai/retry";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  openaiClient ??= new OpenAI({ apiKey: getOpenAIEnv().OPENAI_API_KEY, maxRetries: 0 });
  return openaiClient;
}

export const openai = new Proxy({} as OpenAI, {
  get(_target, prop: keyof OpenAI) {
    const client = getOpenAI();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export const EMBEDDING_MODEL = "text-embedding-3-small";
/** Chat voice input. Multilingual (FI/EN/AR); language is auto-detected. */
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const EMBEDDING_DIMENSIONS = 1536;

/** Batch-embed texts. Multilingual — FI docs answer EN queries (§15.5). */
function retryOptions(signal?: AbortSignal) {
  const { AI_RETRY_MAX_ATTEMPTS, AI_RETRY_BASE_DELAY_MS } = getOpenAIEnv();
  return {
    maxAttempts: AI_RETRY_MAX_ATTEMPTS,
    baseDelayMs: AI_RETRY_BASE_DELAY_MS,
    signal,
  };
}

export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await withAiRetry(
    () =>
      getOpenAI().embeddings.create(
        { model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMENSIONS },
        { signal },
      ),
    retryOptions(signal),
  );
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
  const [e] = await embed([text], signal);
  if (!e) throw new Error("Embedding failed");
  return e;
}

/**
 * Speech-to-text for chat voice input. The audio is sent in memory only and
 * never written anywhere; `extension` must come from server-side format
 * detection (the provider infers the codec from it).
 */
export async function transcribeAudio(
  audio: Uint8Array,
  extension: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await withAiRetry(
    async () =>
      getOpenAI().audio.transcriptions.create(
        {
          file: await toFile(audio, `recording.${extension}`),
          model: TRANSCRIPTION_MODEL,
          response_format: "json",
        },
        { signal },
      ),
    retryOptions(signal),
  );
  return res.text.trim();
}

/** Input guardrail (§15.6). Returns true when content is flagged. */
export async function isFlaggedByModeration(text: string, signal?: AbortSignal): Promise<boolean> {
  const res = await withAiRetry(
    () =>
      getOpenAI().moderations.create(
        { model: "omni-moderation-latest", input: text.slice(0, 30_000) },
        { signal },
      ),
    retryOptions(signal),
  );
  return res.results.some((r) => r.flagged);
}
