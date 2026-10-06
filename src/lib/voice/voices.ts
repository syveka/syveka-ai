import { resolveReplyLanguage, type ReplyLanguage } from "@/lib/voice/reply-language";
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

export type ReplyVoiceChoice =
  | { ok: true; language: ReplyLanguage; lang: string; voice: SpeechSynthesisVoice | undefined }
  | { ok: false; reason: "no_voice"; language: ReplyLanguage }
  | { ok: false; reason: "unknown_language"; language: null };

/**
 * Picks the voice for a reply in the reply's own language, which may differ
 * from turn to turn (see resolveReplyLanguage for how short or ambiguous
 * replies use the user's turn and the session's last language). A language
 * without a device voice, or a reply whose language can't be matched, is
 * shown as text -- never read by another language's voice, and never by the
 * interface language's voice by default.
 */
export function chooseReplyVoice(
  text: string,
  voices: SpeechSynthesisVoice[],
  context: { turn?: string; previous?: ReplyLanguage | null } = {},
): ReplyVoiceChoice {
  const language = resolveReplyLanguage({ reply: text, ...context });
  if (!language) return { ok: false, reason: "unknown_language", language: null };
  const choice = chooseVoice(language, voices);
  return choice.ok ? { ...choice, language } : { ok: false, reason: "no_voice", language };
}
