import "server-only";

import {
  BUSINESS_FACT_RULES,
  buildBusinessDnaPromptBlock,
  NO_BUSINESS_PROFILE_NOTE,
  type BusinessDnaContext,
} from "@/server/business-dna/context";
import { transferCallNumber } from "@/lib/validators/voice";

/**
 * No tool delivers a callback request to the team: createContact and
 * logActivity only write CRM records and nobody is notified. So the
 * assistant must not collect details for a callback or promise one.
 */
const NO_CALLBACK = `No callback: this assistant has no way to pass a callback request to the team. Don't offer a callback, don't ask for the caller's name or number for one, and never say that someone will call back. If you save details with a tool, say only that they were saved, and only after the tool reports success.`;

/**
 * Only a valid number gets Vapi's transferCall tool (toVapiPayload), so the
 * prompt offers a transfer only then — a stored number alone proves nothing.
 * Even with the tool, the transfer itself can fail after the model hands off.
 */
function reachingAPersonSection(transferNumber: string | null): string {
  const transfer = transferCallNumber(transferNumber);
  if (transfer) {
    return `## Reaching a person
If the caller asks for a person, use the transferCall tool to transfer the call to ${transfer}. Say that you are transferring them, not that someone will answer. If the transfer does not go through, say so honestly.
${NO_CALLBACK}`;
  }
  return `## Reaching a person
You cannot transfer this call. If the caller asks for a person, say honestly that you can't connect them on this call. If the business profile states a phone number, email or other way to reach the business, give it; otherwise say you can't confirm how to reach the team, and offer to help with what you can.
${NO_CALLBACK}`;
}

/**
 * Composes the final Vapi system prompt: the mandatory AI-disclosure
 * (§13.3, §16.5) first, then Business DNA context (or a note that there is
 * none — the assistant degrades gracefully when the org hasn't filled it in
 * yet), then the human-authored assistant prompt, then the shared
 * business-fact rules and which ways of reaching a person really exist.
 * Never fabricates a fact Business DNA doesn't contain.
 */
export function buildVoiceSystemPrompt(params: {
  disclosure: string;
  businessDna: BusinessDnaContext | null;
  assistantSystemPrompt: string;
  transferNumber: string | null;
}): string {
  return [
    params.disclosure,
    buildBusinessDnaPromptBlock(params.businessDna) ?? NO_BUSINESS_PROFILE_NOTE,
    params.assistantSystemPrompt,
    BUSINESS_FACT_RULES,
    reachingAPersonSection(params.transferNumber),
  ].join("\n\n");
}
