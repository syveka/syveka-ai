/**
 * Turns an assistant chat reply into text suitable for text-to-speech:
 * drops `[doc:…]` citation markers (they stay visible in the chat thread),
 * markdown syntax, code blocks and raw URLs, which would otherwise be read
 * aloud literally.
 */
export function toSpokenText(reply: string): string {
  return reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s*\[doc:[^\]]*\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Splits text into utterance-sized chunks at sentence boundaries. Some
 * browsers (notably Chrome) silently stop speaking a single long utterance
 * after roughly 15 seconds, so long replies are queued as several.
 */
export function splitForSpeech(text: string, maxLength = 220): string[] {
  const sentences = text.match(/[^.!?。؟\n]+[.!?。؟]*\s*|\n+/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (current && current.length + sentence.length + 1 > maxLength) {
      chunks.push(current);
      current = "";
    }
    if (sentence.length > maxLength) {
      for (let i = 0; i < sentence.length; i += maxLength) {
        chunks.push(sentence.slice(i, i + maxLength));
      }
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

const SPEECH_LANG: Record<string, string> = { fi: "fi-FI", en: "en-US", ar: "ar-SA" };

/** BCP-47 tag for speech recognition/synthesis from the app locale. */
export function speechLangFor(locale: string): string {
  return SPEECH_LANG[locale.toLowerCase()] ?? "en-US";
}
