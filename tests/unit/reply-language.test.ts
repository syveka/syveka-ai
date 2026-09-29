import { describe, expect, it } from "vitest";
import { detectReplyLanguage, resolveReplyLanguage } from "@/lib/voice/reply-language";
import { chooseReplyVoice } from "@/lib/voice/voices";
import { buildSystemPrompt } from "@/server/ai/prompts/system";

/**
 * Spoken replies are read by a voice for each reply's own language; users may
 * switch between Finnish, English and Arabic within one session. Before this
 * fix, live mode and Listen always used the interface language's voice, so a
 * Finnish reply in an English session was read by the English voice.
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

  it("short text: script decides Arabic; Finnish needs a Finnish word (ä/ö only support it)", () => {
    expect(detectReplyLanguage("نعم")).toBe("ar");
    expect(detectReplyLanguage("Selvä!")).toBe("fi");
    expect(detectReplyLanguage("Kyllä, huomenna.")).toBe("fi");
    expect(detectReplyLanguage("Yes, tomorrow.")).toBe("en");
  });

  it("stays undecided on short text without such evidence", () => {
    expect(detectReplyLanguage("OK.")).toBeNull();
    expect(detectReplyLanguage("Auki klo 9–17")).toBeNull();
    expect(detectReplyLanguage("10:30")).toBeNull();
  });

  it("ä/ö alone never prove Finnish: Swedish, German and names stay undecided", () => {
    expect(detectReplyLanguage("Hej, jag är här.")).toBeNull(); // Swedish
    expect(detectReplyLanguage("Du kan se det här.")).toBeNull(); // Swedish, with Finnish-looking "se"
    expect(detectReplyLanguage("Grüße aus München, Jörg")).toBeNull(); // German
    expect(detectReplyLanguage("Jörg Möller")).toBeNull(); // a name
    expect(detectReplyLanguage("Päivi Mäkelä")).toBeNull(); // a Finnish name is not Finnish text
    expect(
      detectReplyLanguage("Vi har två lediga tider i morgon för mötet med kunden."),
    ).toBeNull(); // longer Swedish
    expect(
      detectReplyLanguage("Ich habe für Sie zwei freie Termine morgen, das ist möglich."),
    ).toBeNull(); // longer German
  });

  it("English with Finnish or German names stays English", () => {
    expect(
      detectReplyLanguage(
        "Your meeting with Päivi Mäkelä is at ten tomorrow, and it is confirmed.",
      ),
    ).toBe("en");
    expect(detectReplyLanguage("Yes, Jörg can join at ten.")).toBe("en");
  });

  it("names and places don't flip the language", () => {
    expect(
      detectReplyLanguage("Your meeting with Paavo in Espoo is at ten tomorrow, and it is free."),
    ).toBe("en");
    expect(detectReplyLanguage("Sinun Microsoft Teams -kokous on huomenna, ja se on vapaa.")).toBe(
      "fi",
    );
  });

  it("stays undecided when the evidence is mixed", () => {
    expect(
      detectReplyLanguage("Hei and the ja is kello to meeting huomenna with Paavo"),
    ).toBeNull();
  });
});

describe("resolveReplyLanguage (short replies use turn and session context)", () => {
  it("the reply's own language wins", () => {
    expect(resolveReplyLanguage({ reply: EN, turn: "Mitä huomenna?", previous: "fi" })).toBe("en");
  });

  it("an undecided reply uses the language of the user's turn", () => {
    expect(resolveReplyLanguage({ reply: "OK.", turn: "Mitä kalenterissa on tänään?" })).toBe("fi");
    expect(resolveReplyLanguage({ reply: "OK.", turn: "What is on the calendar today?" })).toBe(
      "en",
    );
  });

  it("ambiguous words and names use the current turn's language", () => {
    expect(
      resolveReplyLanguage({
        reply: "Päivi Mäkelä.",
        turn: "Who is the contact person for Espoo?",
      }),
    ).toBe("en");
    expect(
      resolveReplyLanguage({ reply: "Jörg Möller.", turn: "Kuka on yhteyshenkilö tänään?" }),
    ).toBe("fi");
    expect(resolveReplyLanguage({ reply: "Päivi Mäkelä." })).toBeNull(); // no context → text
  });

  it("…then the session's last language", () => {
    expect(resolveReplyLanguage({ reply: "OK.", turn: "Hmm", previous: "en" })).toBe("en");
  });

  it("context must fit the reply's script: a Latin reply is never read by the Arabic voice", () => {
    expect(resolveReplyLanguage({ reply: "OK.", turn: "ما هي مواعيدي غدًا؟" })).toBeNull();
    expect(resolveReplyLanguage({ reply: "OK.", previous: "ar" })).toBeNull();
    expect(
      resolveReplyLanguage({ reply: "OK.", turn: "ما هي مواعيدي غدًا؟", previous: "en" }),
    ).toBe("en");
  });

  it("no evidence at all → undecided (no default to the interface language)", () => {
    expect(resolveReplyLanguage({ reply: "OK." })).toBeNull();
  });
});

describe("chooseReplyVoice", () => {
  it("uses the voice for the reply's language, whatever the interface language", () => {
    const choice = chooseReplyVoice(FI, voices("en-US", "fi-FI", "ar-SA"));
    expect(choice).toMatchObject({ ok: true, language: "fi", lang: "fi-FI" });
    expect(choice.ok && choice.voice?.lang).toBe("fi-FI");
    expect(chooseReplyVoice(AR, voices("en-US", "fi-FI", "ar-SA"))).toMatchObject({
      lang: "ar-SA",
    });
  });

  it("no device voice for the language → no_voice (text), never another language's voice", () => {
    expect(chooseReplyVoice(FI, voices("en-US", "ar-SA"))).toEqual({
      ok: false,
      reason: "no_voice",
      language: "fi",
    });
  });

  it("unmatched language → unknown_language (text)", () => {
    expect(chooseReplyVoice("OK.", voices("en-US", "fi-FI"))).toEqual({
      ok: false,
      reason: "unknown_language",
      language: null,
    });
  });

  it("Android lists voices as fi_FI too", () => {
    expect(chooseReplyVoice(FI, voices("en_US", "fi_FI"))).toMatchObject({
      ok: true,
      lang: "fi-FI",
    });
  });
});

describe("live voice prompt: multilingual, read-only", () => {
  const prompt = (locale: string, responseMode: "text" | "voice") =>
    buildSystemPrompt({
      locale,
      org: { name: "Acme Oy" },
      ragContext: [],
      hasTools: true,
      responseMode,
    });

  it.each(["fi", "en", "ar"])(
    "a %s-interface session answers in the language of the current turn and may switch",
    (locale) => {
      const system = prompt(locale, "voice");
      expect(system).toContain("answer in the language of the user's current message");
      expect(system).toContain(
        "The user may switch languages between turns; follow the latest turn",
      );
      expect(system).not.toContain("answer only in");
    },
  );

  it("explains that availability can be checked but meetings can't be booked", () => {
    const system = prompt("en", "voice");
    expect(system).toContain("check calendar availability");
    expect(system).toContain("cannot create or change records, book meetings or send anything");
    expect(system).toContain("you may check and tell them the free times");
    expect(system).toContain("book in the typed chat");
  });

  it("typed chat is unchanged", () => {
    const system = prompt("en", "text");
    expect(system).toContain("You answer in the language of the user's message.");
    expect(system).not.toContain("## Live voice conversation");
  });
});
