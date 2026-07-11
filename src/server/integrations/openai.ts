import "server-only";

import OpenAI from "openai";
import { env } from "@/env";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  openaiClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
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
export const EMBEDDING_DIMENSIONS = 1536;

/** Batch-embed texts. Multilingual — FI docs answer EN queries (§15.5). */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedOne(text: string): Promise<number[]> {
  const [e] = await embed([text]);
  if (!e) throw new Error("Embedding failed");
  return e;
}

/** Input guardrail (§15.6). Returns true when content is flagged. */
export async function isFlaggedByModeration(text: string): Promise<boolean> {
  const res = await getOpenAI().moderations.create({
    model: "omni-moderation-latest",
    input: text.slice(0, 30_000),
  });
  return res.results.some((r) => r.flagged);
}
