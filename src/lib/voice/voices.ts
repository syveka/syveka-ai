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
