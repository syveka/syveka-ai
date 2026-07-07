import { readFileSync } from "node:fs";

const locales = ["en", "fi", "ar"];
const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

const keysByLocale = Object.fromEntries(
  locales.map((l) => [l, new Set(flatten(JSON.parse(readFileSync(`messages/${l}.json`, "utf8"))))]),
);

const reference = keysByLocale.en;
let failed = false;
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
