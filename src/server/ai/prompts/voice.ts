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

// Spoken before the owner's greeting on every call. The system-prompt disclosure alone isn't
// enough: the model may skip it, and the greeting is spoken before the model runs at all.
const SPOKEN_AI_DISCLOSURE: Record<"FI" | "EN" | "AR", string> = {
  FI: "Puhut tekoälyavustajan kanssa, ja puhelu voidaan tallentaa.",
  EN: "You are speaking with an AI assistant, and this call may be recorded.",
  AR: "أنت تتحدث مع مساعد يعمل بالذكاء الاصطناعي، وقد يتم تسجيل هذه المكالمة.",
};

/** The assistant's first spoken message: the fixed AI and recording notice, then the greeting. */
export function buildVoiceFirstMessage(language: string, greeting: string): string {
  const notice =
    SPOKEN_AI_DISCLOSURE[language as keyof typeof SPOKEN_AI_DISCLOSURE] ?? SPOKEN_AI_DISCLOSURE.EN;
  return `${notice} ${greeting}`;
}
