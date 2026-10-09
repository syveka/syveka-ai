import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IntlErrorCode, createTranslator } from "next-intl";

/**
 * Every message must be valid ICU syntax. The parity check only compares keys, so a message
 * with literal braces (`{{customer}}`) passed it while next-intl rendered the key path instead
 * of the text. Literal braces are written as `'{{'customer'}}'`.
 */
const LOCALES = ["en", "fi", "ar"] as const;

function messageKeys(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    messageKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translation messages", () => {
  for (const locale of LOCALES) {
    it(`are valid ICU messages in ${locale}`, () => {
      const messages = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"),
      ) as Record<string, unknown>;
      const invalid: string[] = [];
      const t = createTranslator({
        locale,
        messages,
        // Missing argument values are expected here; only syntax errors matter.
        onError: (error) => {
          if (error.code === IntlErrorCode.INVALID_MESSAGE) invalid.push(error.message);
        },
        getMessageFallback: ({ key }) => key,
      });
      for (const key of messageKeys(messages)) t(key as never);
      expect(invalid).toEqual([]);
    });
  }

  it("detects an invalid message (the check is not vacuous)", () => {
    const invalid: string[] = [];
    const t = createTranslator({
      locale: "en",
      messages: { bad: "Use {{name}} here" },
      onError: (error) => {
        if (error.code === IntlErrorCode.INVALID_MESSAGE) invalid.push(error.message);
      },
      getMessageFallback: ({ key }) => key,
    });
    t("bad" as never);
    expect(invalid).toHaveLength(1);
  });

  it("renders escaped braces literally", () => {
    const messages = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
    ) as Record<string, unknown>;
    const t = createTranslator({ locale: "en", messages });
    expect(t("prompts.variableHint" as never)).toBe("Use {{name}} to define fill-in variables.");
  });
});
