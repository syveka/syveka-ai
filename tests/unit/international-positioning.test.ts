import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildPublicAssistantSystemPrompt } from "../../src/server/ai/prompts/public-assistant";

/**
 * Syveka is positioned internationally (EN/FI/AR). General marketing copy and
 * the public assistant's product facts must not describe it as a product for
 * Finnish companies only. Finland-specific products and Finnish legal terms
 * (for example Y-tunnus, which the onboarding validator enforces) are not
 * general positioning and aren't covered here.
 */
function messagesFor(locale: string) {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"),
  );
}

const FINLAND_ONLY = /finnish smb|finnish (businesses|companies)|suomalaisille pk|فنلندا/i;

describe("international positioning", () => {
  it.each(["en", "fi", "ar"])("the %s hero subtitle doesn't limit Syveka to Finland", (locale) => {
    const subtitle: string = messagesFor(locale).marketing.heroSubtitle;
    expect(subtitle.trim()).toBeTruthy();
    expect(subtitle).not.toMatch(FINLAND_ONLY);
  });

  it.each(["en", "fi", "ar"])(
    "the %s phone-number messages offer any local number, not only a Finnish one",
    (locale) => {
      const voice = messagesFor(locale).voice;
      expect(voice.activatePhoneNumberPending).not.toMatch(
        /finnish number|suomalaisen numeron|رقم فنلندي\./i,
      );
    },
  );

  it.each(["en", "fi", "ar"])(
    "the public assistant's %s product facts are international",
    (locale) => {
      const prompt = buildPublicAssistantSystemPrompt(locale);
      expect(prompt).not.toMatch(FINLAND_ONLY);
      expect(prompt).toMatch(/Finnish, English, and Arabic/);
    },
  );
});
