import "server-only";

import { randomUUID } from "node:crypto";
import { streamClaude } from "@/server/integrations/anthropic";
import { routeModel } from "@/server/ai/router";
import type { CreatorCaptionProvider, CaptionRequest, CaptionResult } from "./types";

const LANGUAGE_NAME: Record<string, string> = { EN: "English", FI: "Finnish", AR: "Arabic" };

/**
 * Real caption generation via the platform's existing Anthropic integration
 * (routeModel("draft") — same route used for other short-form AI drafts).
 * Unlike image/video, this genuinely calls a provider; tests must mock
 * streamClaude (see tests/unit/creator-captions.test.ts) rather than let
 * this hit the network — CI must never make paid external calls.
 */
export class ClaudeCaptionProvider implements CreatorCaptionProvider {
  readonly name = "anthropic";

  async generateCaption(req: CaptionRequest): Promise<CaptionResult> {
    const start = Date.now();
    const route = routeModel("draft");
    const system = [
      "You write social media captions for a business's Creator Studio content.",
      `Write in ${LANGUAGE_NAME[req.language] ?? req.language}.`,
      `Platform: ${req.platform}.`,
      req.tone ? `Tone: ${req.tone}.` : "",
      req.objective ? `Campaign objective: ${req.objective}.` : "",
      req.businessContext ? `Business context:\n${req.businessContext}` : "",
      'Respond with ONLY a compact JSON object matching exactly this shape: {"primary": string, "short": string, "cta": string, "hashtags": string[]}. No markdown, no commentary, no code fences.',
    ]
      .filter(Boolean)
      .join("\n");

    let buffer = "";
    await streamClaude({
      model: route.model,
      system,
      messages: [{ role: "user", content: "Generate the caption now." }],
      maxTokens: route.maxTokens,
      callbacks: {
        onText: (delta) => {
          buffer += delta;
        },
      },
    });

    const parsed = parseCaptionJson(buffer);
    return {
      ...parsed,
      providerRequestId: `anthropic_${randomUUID()}`,
      latencyMs: Date.now() - start,
    };
  }
}

function parseCaptionJson(
  raw: string,
): Pick<CaptionResult, "primary" | "short" | "cta" | "hashtags"> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Caption provider returned no parseable JSON");

  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    throw new Error("Caption provider returned malformed JSON");
  }

  const record = data as Partial<Record<"primary" | "short" | "cta" | "hashtags", unknown>>;
  if (
    typeof record.primary !== "string" ||
    typeof record.short !== "string" ||
    typeof record.cta !== "string" ||
    !Array.isArray(record.hashtags)
  ) {
    throw new Error("Caption provider returned an unexpected shape");
  }

  return {
    primary: record.primary,
    short: record.short,
    cta: record.cta,
    hashtags: record.hashtags.filter((h): h is string => typeof h === "string"),
  };
}
