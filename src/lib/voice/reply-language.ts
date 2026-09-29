/**
 * Conservative language detection for spoken replies (fi / en / ar only).
 *
 * Used to avoid reading a reply with a voice for another language. It
 * returns a language only when the evidence is strong, and null otherwise,
 * so callers fall back to the interface language:
 * - Arabic vs Latin is decided by script, which is reliable;
 * - Finnish vs English is decided by common function words (plus ä/ö), and
 *   only when one side clearly dominates. Names, places and short replies
 *   stay undecided.
 */
export type ReplyLanguage = "fi" | "en" | "ar";

const MIN_LETTERS = 20;

// Frequent words that are not also common words of the other language
// ("on", "me", "he", "no" are deliberately left out).
const FINNISH_WORDS = new Set([
  "ja",
  "ei",
  "että",
  "se",
  "ovat",
  "olen",
  "olet",
  "olemme",
  "voit",
  "voin",
  "voimme",
  "kanssa",
  "mutta",
  "myös",
  "tai",
  "kun",
  "jos",
  "sinun",
  "teidän",
  "meidän",
  "minä",
  "sinä",
  "hän",
  "tämä",
  "tämän",
  "siitä",
  "sitä",
  "mitä",
  "kuin",
  "vain",
  "nyt",
  "huomenna",
  "tänään",
  "kello",
  "klo",
  "ole",
  "oli",
  "kaikki",
  "paljon",
  "hyvin",
  "kiitos",
  "voi",
  "joka",
  "jotka",
  "sekä",
  "vielä",
  "sitten",
  "täällä",
]);
const ENGLISH_WORDS = new Set([
  "the",
  "and",
  "is",
  "are",
  "you",
  "your",
  "to",
  "of",
  "for",
  "with",
  "that",
  "this",
  "it",
  "can",
  "will",
  "be",
  "have",
  "has",
  "in",
  "at",
  "we",
  "our",
  "there",
  "here",
  "today",
  "tomorrow",
  "what",
  "which",
  "would",
  "could",
  "about",
  "from",
  "they",
]);

export function detectReplyLanguage(text: string): ReplyLanguage | null {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return null;
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  if (arabic / letters >= 0.5) return "ar";
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (latin / letters < 0.8) return null;

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let fi = 0;
  let en = 0;
  for (const word of words) {
    if (FINNISH_WORDS.has(word)) fi++;
    else if (ENGLISH_WORDS.has(word)) en++;
  }
  if ((text.match(/[äöÄÖ]/g)?.length ?? 0) >= 2) fi += 2;

  if (fi >= 3 && fi >= 3 * en) return "fi";
  if (en >= 3 && en >= 3 * fi) return "en";
  return null;
}
