/** The parts of a `chat` translator this needs (next-intl's useTranslations("chat")). */
export type ChatErrorTranslator = {
  (key: never): string;
  has: (key: never) => boolean;
};

/**
 * The sentence for a chat error code. t() returns the key path for a missing
 * message, never null, so a code without a message is detected with t.has()
 * and shown as the generic error instead of "chat.errors.<code>".
 */
export function chatErrorText(t: ChatErrorTranslator, code: string): string {
  const key = `errors.${code}` as never;
  return t.has(key) ? t(key) : t("errors.generic" as never);
}
