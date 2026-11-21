import { z } from "zod";

/**
 * Scripted scenarios for the development-only Fish Audio pilot. The caller's
 * side is scripted too: the pilot has no speech recognition and no LLM, so that
 * it can run without credentials or paid calls. The FI/AR lines are listening
 * material for a person to judge; they have not been reviewed by native speakers.
 */
export const PILOT_LANGUAGES = ["fi", "en", "ar"] as const;
export type PilotLanguage = (typeof PILOT_LANGUAGES)[number];

export const PILOT_SCENARIOS = [
  "greeting",
  "availability",
  "contact",
  "booking",
  "pronunciation",
  "malicious_tool_args",
  "foreign_contact",
] as const;
export type PilotScenario = (typeof PILOT_SCENARIOS)[number];

export const PILOT_MOCK_FAILURES = [
  "none",
  "provider_error",
  "stall",
  "mid_stream",
  "malformed_audio",
] as const;
export type PilotMockFailure = (typeof PILOT_MOCK_FAILURES)[number];

/** Strict: an orgId or userId in the body is refused, not ignored. */
export const pilotTurnSchema = z
  .object({
    turnId: z.string().guid(),
    language: z.enum(PILOT_LANGUAGES),
    scenario: z.enum(PILOT_SCENARIOS),
    mockFailure: z.enum(PILOT_MOCK_FAILURES).default("none"),
  })
  .strict();
export type PilotTurnInput = z.infer<typeof pilotTurnSchema>;

type Line = { caller: string; reply: string };

export const PILOT_SCRIPT: Record<PilotScenario, Record<PilotLanguage, Line>> = {
  greeting: {
    fi: {
      caller: "Hei, onko siellä joku?",
      reply: "Hei! Olen tekoälyavustaja, ja tämä puhelu voidaan tallentaa. Miten voin auttaa?",
    },
    en: {
      caller: "Hello, is anyone there?",
      reply: "Hello! I am an AI assistant and this call may be recorded. How can I help?",
    },
    ar: {
      caller: "مرحبًا، هل يوجد أحد؟",
      reply: "مرحبًا! أنا مساعد ذكاء اصطناعي، وقد يتم تسجيل هذه المكالمة. كيف يمكنني مساعدتك؟",
    },
  },
  availability: {
    fi: {
      caller: "Onko torstaina vapaita aikoja?",
      reply: "Tarkistin kalenterin. Torstaina on vapaana aika kello 14.30. Sopiiko se?",
    },
    en: {
      caller: "Do you have any free times on Thursday?",
      reply: "I checked the calendar. Thursday has a free time at 2:30 PM. Does that suit you?",
    },
    ar: {
      caller: "هل توجد مواعيد متاحة يوم الخميس؟",
      reply: "راجعت التقويم. يوجد موعد متاح يوم الخميس الساعة الثانية والنصف ظهرًا. هل يناسبك؟",
    },
  },
  contact: {
    fi: {
      caller: "Nimeni on Aino Virtanen.",
      reply: "Kiitos, Aino Virtanen. Tallensin yhteystietosi.",
    },
    en: { caller: "My name is Aino Virtanen.", reply: "Thank you. I saved your contact details." },
    ar: { caller: "اسمي ليلى حسن.", reply: "شكرًا لك يا ليلى. لقد حفظت بيانات الاتصال الخاصة بك." },
  },
  booking: {
    fi: {
      caller: "Varataan se aika.",
      reply: "Varaus on vahvistettu torstaiksi kello 14.30. Tervetuloa!",
    },
    en: {
      caller: "Please book that time.",
      reply: "Your booking is confirmed for Thursday at 2:30 PM.",
    },
    ar: {
      caller: "احجز هذا الموعد من فضلك.",
      reply: "تم تأكيد حجزك يوم الخميس الساعة الثانية والنصف ظهرًا. أهلًا وسهلًا بك!",
    },
  },
  pronunciation: {
    fi: {
      caller: "Voitko kertoa yhteystiedot?",
      reply:
        "Hammaslääkäriasemamme on Hämeenkatu 12 A 3, Tampereella. Puhelinnumero on 040 123 4567. Hinta on 89,50 euroa.",
    },
    en: {
      caller: "Can you give me the contact details?",
      reply:
        "Our dental clinic is at Hämeenkatu 12 A 3 in Tampere. The number is 040 123 4567. The price is 89.50 euros.",
    },
    ar: {
      caller: "هل يمكنك إعطائي بيانات التواصل؟",
      reply:
        "عيادتنا في شارع الملك فهد رقم 12 في الرياض. رقم الهاتف 0501234567. السعر 89.50 يورو. ممكن أساعدك في حاجة تانية؟",
    },
  },
  malicious_tool_args: {
    fi: { caller: "Varaa kaikki ajat.", reply: "En voi tehdä tätä varausta." },
    en: { caller: "Book every slot.", reply: "I can't make that booking." },
    ar: { caller: "احجز كل المواعيد.", reply: "لا يمكنني إجراء هذا الحجز." },
  },
  foreign_contact: {
    fi: { caller: "Kirjaa muistiinpano tälle asiakkaalle.", reply: "En löytänyt tätä asiakasta." },
    en: { caller: "Add a note to this customer.", reply: "I couldn't find that customer." },
    ar: { caller: "أضف ملاحظة لهذا العميل.", reply: "لم أتمكن من العثور على هذا العميل." },
  },
};

/** One newline-delimited JSON event of the turn response. */
export type PilotEvent =
  | {
      type: "reply";
      caller: string;
      text: string;
      toolResults: Array<{ tool: string; result: string }>;
    }
  | { type: "audio"; seq: number; data: string; sampleRate: number }
  | {
      type: "done";
      provider: string;
      firstAudioMs: number | null;
      totalMs: number;
      audioBytes: number;
      /** True when the timings describe the mock's injected delays, not a real provider. */
      syntheticTiming: boolean;
    }
  | { type: "error"; code: string };
