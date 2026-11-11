import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import fi from "../../messages/fi.json";
import ar from "../../messages/ar.json";

/**
 * Every error code the chat can show has a sentence in each language. The
 * view looks a code up under chat.errors and falls back to the generic message
 * only when the key is missing (t.has), so a code without a key would show
 * the generic message instead of what went wrong, and before that check the
 * raw key path ("chat.errors.request_failed") was shown.
 *
 * The codes are read from the sources that produce them, so a new code
 * without a translation fails here.
 */
const root = path.join(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function codesIn(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

const routeCodes = codesIn(read("src/app/api/v1/ai/chat/route.ts"), /code: "([a-z_]+)"/g);
const hookCodes = codesIn(read("src/hooks/use-chat.ts"), /setError\("([a-z_]+)"\)/g);
const hookFallbacks = codesIn(read("src/hooks/use-chat.ts"), /\?\? "([a-z_]+)"/g);
// Thrown by guards the route calls, and reported with these codes.
const guardCodes = ["entitlement_exceeded"];

const shownCodes = [
  ...new Set([...routeCodes, ...hookCodes, ...hookFallbacks, ...guardCodes, "generic"]),
].sort();

const locales = { en, fi, ar } as const;

describe("chat error messages", () => {
  it("finds the codes the chat produces", () => {
    expect(routeCodes).toContain("moderation_unavailable");
    expect(routeCodes).toContain("service_unavailable");
    expect(hookFallbacks).toContain("request_failed");
    expect(hookCodes).toContain("network_error");
  });

  it.each(Object.entries(locales))("%s has a sentence for every code", (_locale, messages) => {
    const errors = messages.chat.errors as Record<string, string>;
    const missing = shownCodes.filter((code) => typeof errors[code] !== "string" || !errors[code]);
    expect(missing).toEqual([]);
    for (const code of shownCodes) {
      // A sentence, not a key path or a placeholder.
      expect(errors[code]).not.toMatch(/^chat\.errors\./);
      expect(errors[code]!.trim().length).toBeGreaterThan(5);
    }
  });

  it("the three languages have the same chat.errors keys", () => {
    const keys = (messages: { chat: { errors: object } }) =>
      Object.keys(messages.chat.errors).sort();
    expect(keys(fi)).toEqual(keys(en));
    expect(keys(ar)).toEqual(keys(en));
  });

  it("the view checks that a code has a message before showing it", () => {
    const view = read("src/components/chat/chat-view.tsx");
    expect(view).toMatch(/t\.has\(errorKey\) \? t\(errorKey\) : t\("errors\.generic"\)/);
    // The previous fallback could never apply: t() returns the key path.
    expect(view).not.toMatch(/t\(`errors\.\$\{error\}` as never\) \?\?/);
  });
});
