import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public marketing pages (landing, pricing, footer) used inline
 * `locale === "fi" ? … : …` ternaries, so Arabic silently fell through to
 * English -- invisible to the i18n parity check, which only compares message
 * files. They must render from the "marketing" message namespace.
 */
const root = path.join(__dirname, "../..");
const messages = (locale: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "messages", `${locale}.json`), "utf8")) as {
    marketing: Record<string, string>;
  };
const MARKETING_FILES = [
  "src/app/[locale]/(marketing)/page.tsx",
  "src/app/[locale]/(marketing)/pricing/page.tsx",
  "src/app/[locale]/(marketing)/layout.tsx",
];

describe("marketing pages are localized for every locale", () => {
  const en = messages("en").marketing;

  it("has the same marketing keys in en, fi and ar", () => {
    for (const locale of ["fi", "ar"]) {
      expect(Object.keys(messages(locale).marketing).sort(), locale).toEqual(
        Object.keys(en).sort(),
      );
    }
  });

  it("has genuinely Arabic (not English) copy for every Arabic marketing string", () => {
    const ar = messages("ar").marketing;
    for (const [key, value] of Object.entries(ar)) {
      expect(value, key).toMatch(/[؀-ۿ]/);
      expect(value, key).not.toBe(en[key]);
    }
  });

  it("keeps ICU placeholders consistent across locales", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of ["fi", "ar"]) {
      const other = messages(locale).marketing;
      for (const key of Object.keys(en)) {
        expect(placeholders(other[key]!), `${locale}.${key}`).toEqual(placeholders(en[key]!));
      }
    }
  });

  it("never branches on locale strings in the marketing page sources", () => {
    for (const file of MARKETING_FILES) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      // A locale ternary returning human-readable copy (spaces or non-ASCII
      // letters) is a hardcoded translation; one returning a locale tag such
      // as "ar-u-nu-latn" (number formatting) is fine.
      expect(source, file).not.toMatch(
        /(locale\s*===\s*["'](fi|en|ar)["']|\bfi)\s*\?\s*["'][^"']*[\sÀ-￿][^"']*["']/,
      );
    }
  });

  it("renders the footer links from translations, not hardcoded English", () => {
    const layout = fs.readFileSync(path.join(root, MARKETING_FILES[2]!), "utf8");
    expect(layout).not.toMatch(/>\s*(Privacy|Terms)\s*</);
    expect(layout).toContain('t("footerPrivacy")');
    expect(layout).toContain('t("footerTerms")');
  });
});
