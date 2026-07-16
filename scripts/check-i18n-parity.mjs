import { readFileSync } from "node:fs";

const locales = ["en", "fi", "ar"];
const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

const findDottedKeys = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const invalid = key.includes(".") ? [path] : [];
    return typeof value === "object" && value !== null
      ? [...invalid, ...findDottedKeys(value, path)]
      : invalid;
  });

const messagesByLocale = Object.fromEntries(
  locales.map((locale) => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"))]),
);

const keysByLocale = Object.fromEntries(
  locales.map((locale) => [locale, new Set(flatten(messagesByLocale[locale]))]),
);

const reference = keysByLocale.en;
let failed = false;
for (const locale of locales) {
  const dottedKeys = findDottedKeys(messagesByLocale[locale]);
  if (dottedKeys.length > 0) {
    failed = true;
    console.error(`✗ ${locale}: dotted message keys=[${dottedKeys.join(", ")}]`);
  }
}

for (const locale of locales.slice(1)) {
  const keys = keysByLocale[locale];
  const missing = [...reference].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !reference.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`✗ ${locale}: missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
  } else {
    console.log(`✓ ${locale}: ${keys.size} keys in parity`);
  }
}
process.exit(failed ? 1 : 0);
