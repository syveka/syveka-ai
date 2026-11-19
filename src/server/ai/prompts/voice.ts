import "server-only";

import type { Locale } from "@/generated/prisma/client/client";
import {
  buildBusinessDnaPromptBlock,
  type BusinessDnaContext,
} from "@/server/business-dna/context";

/**
 * Version of the mandatory AI-and-recording disclosure wording below. Bump it
 * whenever any notice or instruction text changes.
 */
export const VOICE_DISCLOSURE_VERSION = "2026-11-19";

/**
 * Mandatory AI/recording disclosure (§13.3, §16.5). Server-owned: it is
 * prepended to the spoken first message at sync time, so a tenant-edited
 * firstMessage can never remove it. Never persisted to the assistant row.
 */
export const VOICE_DISCLOSURE_NOTICE: Record<Locale, string> = {
  FI: "Puhut tekoälyavustajan kanssa, ja puhelu voidaan tallentaa.",
  EN: "You are speaking with an AI assistant, and this call may be recorded.",
  AR: "هذه المكالمة مع مساعد ذكاء اصطناعي، وقد يتم تسجيلها.",
};

/**
 * System-prompt instruction backing the spoken notice, per language. Vapi
 * speaks the notice itself as part of firstMessage, so the model must not
 * repeat it unprompted.
 */
export const VOICE_DISCLOSURE_INSTRUCTION: Record<Locale, string> = {
  FI: "Puhelu on jo alkanut ilmoituksella, että olet tekoälyavustaja ja että puhelu voidaan tallentaa. Älä toista ilmoitusta pyytämättä; jos sinulta kysytään, vahvista se totuudenmukaisesti äläkä koskaan väitä olevasi ihminen.",
  EN: "The call has already opened with a notice that you are an AI assistant and that the call may be recorded. Do not repeat it unprompted; if asked, confirm it truthfully and never claim to be human.",
  AR: "بدأت المكالمة بالفعل بإشعار بأنك مساعد ذكاء اصطناعي وأن المكالمة قد يتم تسجيلها. لا تكرر ذلك من تلقاء نفسك، وإذا سُئلت فأكّد ذلك بصدق ولا تدّعِ أبدًا أنك إنسان.",
};

export function voiceDisclosureInstruction(language: Locale): string {
  return VOICE_DISCLOSURE_INSTRUCTION[language];
}

/** The spoken first message: the fixed notice always comes first. */
export function buildVoiceFirstMessage(language: Locale, assistantFirstMessage: string): string {
  return [VOICE_DISCLOSURE_NOTICE[language], assistantFirstMessage.trim()]
    .filter(Boolean)
    .join(" ");
}

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
