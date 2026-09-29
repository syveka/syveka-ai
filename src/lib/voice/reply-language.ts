/**
 * Language of spoken replies (fi / en / ar only), so each reply is read by a
 * voice for its own language. Users may switch languages between turns.
 *
 * Detection returns a language only on strong evidence, otherwise null:
 * - Arabic vs Latin script is decided by the letters themselves;
 * - Finnish vs English by common function words. ä/ö only SUPPORT Finnish
 *   (one point): they also occur in Swedish, German and names, so they never
 *   decide on their own. A decision needs at least one function word of the
 *   winning language, at least two points, and none (short text) or clearly
 *   fewer (long text) for the other side.
 * - Common Swedish/German words veto a Finnish/English decision (those
 *   languages aren't supported; such text stays undecided and falls back to
 *   the user's turn or session context, or to text).
 * Names and places carry no evidence.
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

// Frequent Swedish/German words (not Finnish or English words) whose presence
// means the text isn't clearly Finnish or English. Not a language detector.
const OTHER_LATIN_WORDS = new Set([
  "och",
  "jag",
  "är",
  "det",
  "inte",
  "har",
  "för",
  "med",
  "också",
  "und",
  "ich",
  "nicht",
  "der",
  "das",
  "ist",
  "für",
  "mit",
  "sie",
  "auch",
  "wir",
  "haben",
  "sind",
  "vi",
]);

/**
 * Whether the text contains Swedish/German marker words, i.e. it is at least
 * partly in a language this app doesn't speak (fi / en / ar only).
 */
export function hasUnsupportedLanguageMarkers(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((word) => OTHER_LATIN_WORDS.has(word));
}

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

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let fiWords = 0;
  let en = 0;
  let other = 0;
  for (const word of words) {
    if (FINNISH_WORDS.has(word)) fiWords++;
    else if (ENGLISH_WORDS.has(word)) en++;
    else if (OTHER_LATIN_WORDS.has(word)) other++;
  }
  // ä/ö: supporting evidence only, never decisive.
  const fi = fiWords + (/[äöÄÖ]/.test(text) ? 1 : 0);
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < LONG_TEXT_LETTERS) {
    if (other > 0) return null;
    if (fiWords >= 1 && fi >= 2 && en === 0) return "fi";
    if (en >= 2 && fiWords === 0) return "en";
    return null;
  }
  if (fiWords >= 1 && fi >= 2 && en === 0 && other === 0) return "fi";
  // ä/ö in a name don't count against English: only Finnish words do.
  if (en >= 2 && fiWords === 0 && other === 0) return "en";
  if (fiWords >= 3 && fi >= 3 * (en + other)) return "fi";
  if (en >= 3 && en >= 3 * (fiWords + other)) return "en";
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
 * A reply that isn't itself Finnish/English/Arabic and contains Swedish or
 * German marker words is in an unsupported language: it never inherits a
 * voice from context and is shown as text.
 */
export function resolveReplyLanguage(input: {
  reply: string;
  turn?: string;
  previous?: ReplyLanguage | null;
}): ReplyLanguage | null {
  const own = detectReplyLanguage(input.reply);
  if (own) return own;
  if (hasUnsupportedLanguageMarkers(input.reply)) return null;
  const candidates = [input.turn ? detectReplyLanguage(input.turn) : null, input.previous ?? null];
  return candidates.find((c): c is ReplyLanguage => !!c && fitsScript(c, input.reply)) ?? null;
}
