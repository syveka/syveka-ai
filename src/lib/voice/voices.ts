import { detectReplyLanguage } from "@/lib/voice/reply-language";
import { speechLangFor } from "@/lib/voice/spoken-text";

export type VoiceChoice =
  | { ok: true; lang: string; voice: SpeechSynthesisVoice | undefined }
  | { ok: false; reason: "no_voice" };

/**
 * Picks a device voice for the interface language, preferring on-device
 * voices. Never substitutes another language: a loaded voice list without
 * this language is a definite "no voice". An empty list often just means
 * voices haven't loaded yet (Android), so the engine is left to choose by
 * `lang`.
 */
export function chooseVoice(locale: string, voices: SpeechSynthesisVoice[]): VoiceChoice {
  const lang = speechLangFor(locale);
  const prefix = lang.split("-")[0]!.toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
  if (voices.length > 0 && matching.length === 0) return { ok: false, reason: "no_voice" };
  return { ok: true, lang, voice: matching.find((v) => v.localService) ?? matching[0] };
}

/**
 * Picks the voice for a reply in the reply's own language. Replies usually
 * match the interface language, but when a reply is confidently in another
 * supported language (e.g. Finnish text in an English session), reading it
 * with the interface voice would mispronounce it. Undetected or ambiguous
 * text uses the interface language; a detected language without a device
 * voice is a definite "no voice" (shown as text) -- never another
 * language's voice.
 */
export function chooseReplyVoice(
  locale: string,
  text: string,
  voices: SpeechSynthesisVoice[],
): VoiceChoice {
  return chooseVoice(detectReplyLanguage(text) ?? locale, voices);
}
