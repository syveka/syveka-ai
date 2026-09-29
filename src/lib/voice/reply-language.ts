/**
 * Language of spoken replies (fi / en / ar only), so each reply is read by a
 * voice for its own language. Users may switch languages between turns.
 *
 * Detection returns a language only on strong evidence, otherwise null:
 * - Arabic vs Latin script is decided by the letters themselves;
 * - Latin text containing ä or ö is Finnish (English never uses them);
 * - otherwise Finnish vs English by common function words -- one side must
 *   clearly dominate, and short text needs at least two such words with
 *   none from the other language. Names and places don't count.
 */
export type ReplyLanguage = "fi" | "en" | "ar";

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
  "hei",
  "moi",
  "kyllä",
  "selvä",
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
  "hello",
  "thanks",
  "yes",
]);

const LONG_TEXT_LETTERS = 20;

type Script = "arabic" | "latin" | "none" | "mixed";

function scriptOf(text: string): Script {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return "none";
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (arabic / letters >= 0.5) return "arabic";
  if (latin / letters >= 0.8) return "latin";
  return "mixed";
}

export function detectReplyLanguage(text: string): ReplyLanguage | null {
  const script = scriptOf(text);
  if (script === "arabic") return (text.match(/\p{L}/gu)?.length ?? 0) >= 2 ? "ar" : null;
  if (script !== "latin") return null;
  if (/[äöÄÖ]/.test(text)) return "fi";

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let fi = 0;
  let en = 0;
  for (const word of words) {
    if (FINNISH_WORDS.has(word)) fi++;
    else if (ENGLISH_WORDS.has(word)) en++;
  }
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < LONG_TEXT_LETTERS) {
    if (fi >= 2 && en === 0) return "fi";
    if (en >= 2 && fi === 0) return "en";
    return null;
  }
  if (fi >= 3 && fi >= 3 * en) return "fi";
  if (en >= 3 && en >= 3 * fi) return "en";
  return null;
}

/** Whether `language` can read text written in the reply's script. */
function fitsScript(language: ReplyLanguage, reply: string): boolean {
  const script = scriptOf(reply);
  if (script === "none") return true;
  if (script === "arabic") return language === "ar";
  if (script === "latin") return language !== "ar";
  return false;
}

/**
 * The language to speak a reply in, or null when it can't be matched
 * reliably -- the reply is then shown as text, never read by a guessed
 * voice. In order:
 *   1. the reply's own detected language;
 *   2. the language of the user's turn it answers (from the transcript);
 *   3. the last language confidently used in this session.
 * Context (2-3) is used only when it fits the reply's script, so a short
 * Latin-script reply is never read by the Arabic voice or vice versa. The
 * interface language is deliberately not a fallback: users may speak any of
 * the supported languages regardless of it.
 */
export function resolveReplyLanguage(input: {
  reply: string;
  turn?: string;
  previous?: ReplyLanguage | null;
}): ReplyLanguage | null {
  const own = detectReplyLanguage(input.reply);
  if (own) return own;
  const candidates = [input.turn ? detectReplyLanguage(input.turn) : null, input.previous ?? null];
  return candidates.find((c): c is ReplyLanguage => !!c && fitsScript(c, input.reply)) ?? null;
}
