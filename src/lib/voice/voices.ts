import { resolveReplyLanguage, type ReplyLanguage } from "@/lib/voice/reply-language";
import { speechLangFor } from "@/lib/voice/spoken-text";

export type VoiceChoice =
  | { ok: true; lang: string; voice: SpeechSynthesisVoice | undefined }
  | { ok: false; reason: "no_voice" };

/** Primary language subtag, lower-case: "ar_SA", "ar-XA", "AR" → "ar". */
export function primaryLanguage(tag: string): string {
  return tag.split(/[-_]/)[0]!.toLowerCase();
}

/** Region subtag, upper-case, if any: "fi_fi" → "FI". */
function regionOf(tag: string): string | undefined {
  return tag.split(/[-_]/)[1]?.toUpperCase();
}

/** Hyphenated BCP-47 form of a device voice tag: "ar_sa" → "ar-SA". */
function normalizeTag(tag: string): string {
  const [language = "", ...rest] = tag.split(/[-_]/);
  return [language.toLowerCase(), ...rest.map((p) => (p.length === 2 ? p.toUpperCase() : p))].join(
    "-",
  );
}

/**
 * Picks a device voice for a language, matching the primary language subtag
 * only (so "fil" never stands in for "fi"), preferring on-device voices,
 * then the default region. Never substitutes another language: a voice list
 * without this language is "no voice". An empty list often just means voices
 * haven't loaded yet (Android), so it returns `ok` with no voice and leaves
 * the decision to the caller.
 */
export function chooseVoice(locale: string, voices: SpeechSynthesisVoice[]): VoiceChoice {
  const lang = speechLangFor(locale);
  const primary = primaryLanguage(lang);
  const region = regionOf(lang);
  const matching = voices.filter((v) => primaryLanguage(v.lang ?? "") === primary);
  if (voices.length > 0 && matching.length === 0) return { ok: false, reason: "no_voice" };
  const rank = (v: SpeechSynthesisVoice) =>
    (v.localService ? 2 : 0) + (regionOf(v.lang) === region ? 1 : 0);
  const voice = matching.reduce<SpeechSynthesisVoice | undefined>(
    (best, v) => (!best || rank(v) > rank(best) ? v : best),
    undefined,
  );
  return { ok: true, lang: voice ? normalizeTag(voice.lang) : lang, voice };
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
