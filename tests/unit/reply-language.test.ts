import { describe, expect, it } from "vitest";
import { detectReplyLanguage } from "@/lib/voice/reply-language";
import { chooseReplyVoice } from "@/lib/voice/voices";
import { buildSystemPrompt } from "@/server/ai/prompts/system";

/**
 * Spoken replies must be read by a voice for the reply's own language.
 * Before this fix, live mode and Listen always used the interface language,
 * while the model answered "in the language of the user's message" -- so a
 * Finnish reply in an English session was read with an English voice.
 */
const voices = (...langs: string[]) =>
  langs.map((lang) => ({ lang, localService: true, name: lang }) as SpeechSynthesisVoice);

const FI = "Huomenna kello kymmenen on vapaa aika. Voit varata sen chatissa, jos haluat.";
const EN = "Tomorrow at ten there is a free slot. You can book it in the chat if you want.";
const AR = "غدًا في الساعة العاشرة يوجد موعد متاح. يمكنك حجزه في الدردشة.";

describe("detectReplyLanguage (conservative)", () => {
  it.each([
    [FI, "fi"],
    [EN, "en"],
    [AR, "ar"],
  ])("detects a clear reply: %s → %s", (text, lang) => {
    expect(detectReplyLanguage(text)).toBe(lang);
  });

  it("stays undecided on short replies", () => {
    expect(detectReplyLanguage("Kyllä.")).toBeNull();
    expect(detectReplyLanguage("Yes, sure.")).toBeNull();
  });

  it("names and places don't flip the language", () => {
    expect(
      detectReplyLanguage(
        "Your meeting with Päivi in Hämeenlinna is at ten tomorrow, and it is free.",
      ),
    ).toBe("en");
    expect(detectReplyLanguage("Sinun Microsoft Teams -kokous on huomenna, ja se on vapaa.")).toBe(
      "fi",
    );
  });

  it("stays undecided when the evidence is mixed", () => {
    expect(
      detectReplyLanguage("Hei and the ja is kello to meeting huomenna with Päivi"),
    ).toBeNull();
  });
});

describe("chooseReplyVoice", () => {
  it("a Finnish reply in an English session uses the Finnish voice when the device has one", () => {
    const choice = chooseReplyVoice("en", FI, voices("en-US", "fi-FI"));
    expect(choice).toMatchObject({ ok: true, lang: "fi-FI" });
    expect(choice.ok && choice.voice?.lang).toBe("fi-FI");
  });

  it("…and is NOT read with the English voice when there is no Finnish voice", () => {
    expect(chooseReplyVoice("en", FI, voices("en-US", "ar-SA"))).toEqual({
      ok: false,
      reason: "no_voice",
    });
  });

  it("Android lists voices as fi_FI too", () => {
    expect(chooseReplyVoice("en", FI, voices("en_US", "fi_FI"))).toMatchObject({
      ok: true,
      lang: "fi-FI",
    });
  });

  it("a reply in the session language, or an undecided one, uses the session voice", () => {
    expect(chooseReplyVoice("fi", FI, voices("fi-FI", "en-US"))).toMatchObject({ lang: "fi-FI" });
    expect(chooseReplyVoice("fi", "OK.", voices("fi-FI", "en-US"))).toMatchObject({
      lang: "fi-FI",
    });
    expect(chooseReplyVoice("ar", AR, voices("ar-SA", "en-US"))).toMatchObject({ lang: "ar-SA" });
  });
});

describe("live voice prompt: session language and capabilities", () => {
  const prompt = (locale: string, responseMode: "text" | "voice") =>
    buildSystemPrompt({
      locale,
      org: { name: "Acme Oy" },
      ragContext: [],
      hasTools: true,
      responseMode,
    });

  it.each([
    ["fi", "Finnish"],
    ["en", "English"],
    ["ar", "Arabic"],
  ])("a %s session answers only in %s, overriding the user's-language rule", (locale, language) => {
    const system = prompt(locale, "voice");
    expect(system).toContain(`answer only in ${language}`);
    expect(system).toContain(`read aloud by a ${language} voice`);
    expect(system).toContain(
      "This overrides the rule of answering in the language of the user's message",
    );
  });

  it("explains that availability can be checked but meetings can't be booked", () => {
    const system = prompt("en", "voice");
    expect(system).toContain("check calendar availability");
    expect(system).toContain("cannot create or change records, book meetings or send anything");
    expect(system).toContain("you may check and tell them the free times");
    expect(system).toContain("book in the typed chat");
  });

  it("typed chat keeps answering in the user's language (unchanged)", () => {
    const system = prompt("en", "text");
    expect(system).toContain("You answer in the language of the user's message.");
    expect(system).not.toContain("answer only in");
  });
});
