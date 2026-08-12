import "server-only";

import {
  buildBusinessDnaPromptBlock,
  type BusinessDnaContext,
} from "@/server/business-dna/context";

/**
 * Composes the final Vapi system prompt: the mandatory AI-disclosure
 * (§13.3, §16.5) first, then Business DNA context (if any — the assistant
 * degrades gracefully when the org hasn't filled in Business DNA yet), then
 * the human-authored assistant prompt, then the transfer-number note. Never
 * fabricates a fact Business DNA doesn't contain.
 */
export function buildVoiceSystemPrompt(params: {
  disclosure: string;
  businessDna: BusinessDnaContext | null;
  assistantSystemPrompt: string;
  transferNumber: string | null;
}): string {
  const parts = [params.disclosure];

  const businessDnaBlock = buildBusinessDnaPromptBlock(params.businessDna);
  if (businessDnaBlock) parts.push(businessDnaBlock);

  parts.push(params.assistantSystemPrompt);

  if (params.transferNumber) {
    parts.push(`If the caller asks for a human, transfer the call to ${params.transferNumber}.`);
  }

  return parts.join("\n\n");
}
