import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVoiceFirstMessage, spokenDisclosure } from "@/server/ai/prompts/voice";

/**
 * The spoken notice as an enforced gate. Vapi and Redis are mocked: no call or paid request
 * is made. Real Vapi behaviour still has to be confirmed by the approved call test.
 */
const m = vi.hoisted(() => ({
  store: new Map<string, string>(),
  redisSetFails: false,
  redisGetFails: false,
  getVapiAssistant: vi.fn(),
}));

vi.mock("@/server/integrations/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      if (m.redisSetFails) throw new Error("redis down");
      m.store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => {
      if (m.redisGetFails) throw new Error("redis down");
      return m.store.get(key) ?? null;
    }),
  },
}));
vi.mock("@/server/integrations/vapi", () => ({ getVapiAssistant: m.getVapiAssistant }));

const {
  callDisclosureState,
  disclosureApprovedLanguages,
  earliestCallTime,
  languageApprovedForCall,
  liveConfigDisclosesFirst,
  verifyCallDisclosure,
} = await import("@/server/voice/disclosure-gate");

const AR_NOTICE = spokenDisclosure("AR") as string;
const ids = { orgId: "org-a", vapiCallId: "call-1", vapiAssistantId: "vapi-1" };

beforeEach(() => {
  m.store.clear();
  m.redisSetFails = false;
  m.redisGetFails = false;
  m.getVapiAssistant.mockReset();
  vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01,EN@2000-01-01,AR@2000-01-01");
});
afterEach(() => vi.unstubAllEnvs());

describe("the approved-languages setting", () => {
  const approvedFrom = (setting: string, now = new Date("2026-11-12T12:00:00Z")) => [
    ...disclosureApprovedLanguages({ VOICE_DISCLOSURE_APPROVED_LANGUAGES: setting } as never, now),
  ];

  it("doesn't depend on case or spacing", () => {
    expect(approvedFrom(" fi @ 2026-11-01 , En@2026-11-01T08:00:00Z ")).toEqual(["FI", "EN"]);
  });

  it("approves nothing for an entry without a time, so the old format fails closed", () => {
    expect(approvedFrom("FI,EN,AR")).toEqual([]);
    expect(approvedFrom("FI@,EN@soon,AR@2026-11-01@2026-11-02")).toEqual([]);
  });

  it("needs the time's zone, so it can't be read in a server's local time", () => {
    expect(approvedFrom("FI@2026-11-01T08:00:00")).toEqual([]);
    expect(approvedFrom("FI@2026-11-01T08:00:00+02:00")).toEqual(["FI"]);
  });

  it("doesn't approve a language before its time", () => {
    expect(approvedFrom("FI@2026-11-12T12:00:01Z,EN@2026-11-12T12:00:00Z")).toEqual(["EN"]);
  });

  it("takes the later time when a language is listed twice", () => {
    expect(approvedFrom("FI@2026-11-01,FI@2026-12-01")).toEqual([]);
  });
});

describe("a call's start, from what's stated about it", () => {
  it("is the earliest readable time, so approval is tested strictly", () => {
    const times = ["2026-11-12T08:00:05Z", null, "not a time", "2026-11-12T08:00:00Z", undefined];
    expect(earliestCallTime(...times)).toBe("2026-11-12T08:00:00Z");
    expect(earliestCallTime(undefined, "not a time")).toBeUndefined();
  });
});

describe("approval when a call began", () => {
  const env = { VOICE_DISCLOSURE_APPROVED_LANGUAGES: "AR@2026-11-12T08:00:00Z" } as never;
  const now = new Date("2026-11-12T12:00:00Z");
  const at = (time: string) => Date.parse(time);

  it("holds for a call begun at or after the approval", () => {
    expect(languageApprovedForCall("AR", at("2026-11-12T08:00:00Z"), now, env)).toBe(true);
    expect(languageApprovedForCall("AR", at("2026-11-12T11:59:00Z"), now, env)).toBe(true);
  });

  it("doesn't hold for a call begun before it, however soon before", () => {
    expect(languageApprovedForCall("AR", at("2026-11-12T07:59:59Z"), now, env)).toBe(false);
  });

  it("doesn't hold without a readable start, or for another language", () => {
    expect(languageApprovedForCall("AR", Number.NaN, now, env)).toBe(false);
    expect(languageApprovedForCall("FI", at("2026-11-12T09:00:00Z"), now, env)).toBe(false);
  });

  it("doesn't hold for a start stated after now while the approval is still ahead", () => {
    const early = new Date("2026-11-12T07:00:00Z");
    expect(languageApprovedForCall("AR", at("2026-11-12T09:00:00Z"), early, env)).toBe(false);
  });
});

describe("the notice", () => {
  it.each(["FI", "EN", "AR"])("exists for %s and comes before the greeting", (language) => {
    const notice = spokenDisclosure(language) as string;
    expect(notice.length).toBeGreaterThan(10);
    expect(buildVoiceFirstMessage(language, "Hello!").startsWith(notice)).toBe(true);
  });

  it("each language has its own wording", () => {
    const notices = new Set(["FI", "EN", "AR"].map(spokenDisclosure));
    expect(notices.size).toBe(3);
  });

  it("the Arabic notice is in Arabic, and doesn't address one gender", () => {
    expect(AR_NOTICE).toMatch(/[؀-ۿ]/);
    expect(AR_NOTICE).not.toContain("أنت تتحدث");
  });

  it("has no notice for an unknown language, instead of a wrong one", () => {
    expect(spokenDisclosure("SV")).toBeNull();
    expect(spokenDisclosure("")).toBeNull();
  });
});

describe("approved languages", () => {
  it("none by default", () => {
    expect(disclosureApprovedLanguages({} as NodeJS.ProcessEnv).size).toBe(0);
    expect(
      disclosureApprovedLanguages({
        VOICE_DISCLOSURE_APPROVED_LANGUAGES: " ",
      } as unknown as NodeJS.ProcessEnv).size,
    ).toBe(0);
  });

  it("only those listed, without surrounding spaces", () => {
    const approved = disclosureApprovedLanguages({
      VOICE_DISCLOSURE_APPROVED_LANGUAGES: " FI@2026-01-01 , EN@2026-01-01",
    } as unknown as NodeJS.ProcessEnv);
    expect([...approved]).toEqual(["FI", "EN"]);
  });
});

describe("live configuration", () => {
  const good = { firstMessage: `${AR_NOTICE} مرحبًا` };

  it("accepts the notice first, with Vapi's defaults or explicit values", () => {
    expect(liveConfigDisclosesFirst("AR", good)).toBe(true);
    expect(
      liveConfigDisclosesFirst("AR", {
        ...good,
        firstMessageMode: "assistant-speaks-first",
        firstMessageInterruptionsEnabled: false,
      }),
    ).toBe(true);
  });

  it.each([
    ["no first message", {}],
    ["a null first message", { firstMessage: null }],
    ["a greeting with no notice (an assistant not re-synced)", { firstMessage: "مرحبًا" }],
    ["the notice after the greeting", { firstMessage: `مرحبًا ${AR_NOTICE}` }],
    ["the English notice on an Arabic assistant", { firstMessage: spokenDisclosure("EN") }],
    ["the old masculine wording", { firstMessage: "أنت تتحدث مع مساعد يعمل بالذكاء الاصطناعي" }],
    [
      "a mode where the model writes the opening",
      { ...good, firstMessageMode: "assistant-speaks-first-with-model-generated-message" },
    ],
    ["a mode where the assistant waits", { ...good, firstMessageMode: "assistant-waits-for-user" }],
    ["a notice the caller can cut off", { ...good, firstMessageInterruptionsEnabled: true }],
  ])("refuses %s", (_name, live) => {
    expect(liveConfigDisclosesFirst("AR", live)).toBe(false);
  });

  it("refuses an unknown language", () => {
    expect(liveConfigDisclosesFirst("SV", { firstMessage: "anything" })).toBe(false);
  });
});

describe("checking a call", () => {
  const reported = {
    firstMessage: buildVoiceFirstMessage("FI", "Hei!"),
    firstMessageMode: "assistant-speaks-first",
    firstMessageInterruptionsEnabled: false,
  };

  it("passes on the signed webhook's config, without asking Vapi", async () => {
    const result = await verifyCallDisclosure({ ...ids, language: "FI", reported });
    expect(result).toBe("ok");
    expect(m.getVapiAssistant).not.toHaveBeenCalled();
    expect(await callDisclosureState("org-a", "call-1")).toBe("verified");
  });

  it("asks Vapi, with a short timeout, when the webhook doesn't say", async () => {
    m.getVapiAssistant.mockResolvedValue(reported);
    const result = await verifyCallDisclosure({ ...ids, language: "FI" });
    expect(result).toBe("ok");
    expect(m.getVapiAssistant).toHaveBeenCalledWith("vapi-1", expect.any(AbortSignal));
  });

  it("refuses an unapproved language before anything else", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01");
    const result = await verifyCallDisclosure({ ...ids, language: "AR", reported });
    expect(result).toBe("language_not_approved");
    expect(await callDisclosureState("org-a", "call-1")).toBe("unverified");
  });

  it("refuses a call that began before its language was approved", async () => {
    const approvedAt = new Date(Date.now() - 10_000).toISOString();
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `FI@${approvedAt}`);
    const check = (calledAt: string) =>
      verifyCallDisclosure({ ...ids, language: "FI", reported, calledAt });
    expect(await check(new Date(Date.now() - 20_000).toISOString())).toBe("language_not_approved");
    expect(await check(new Date(Date.now() - 5_000).toISOString())).toBe("ok");
  });

  it("without a stated start, takes an on-time call to have begun a full window ago", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `FI@${new Date().toISOString()}`);
    const result = await verifyCallDisclosure({ ...ids, language: "FI", reported });
    expect(result).toBe("language_not_approved");
  });

  it("refuses a late start with no readable time, since its approval can't be shown", async () => {
    const result = await verifyCallDisclosure({
      ...ids,
      language: "FI",
      reported,
      startIsLate: true,
      calledAt: "not a time",
    });
    expect(result).toBe("language_not_approved");
  });

  it("refuses every language when none is approved", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "");
    const result = await verifyCallDisclosure({ ...ids, language: "FI", reported });
    expect(result).toBe("language_not_approved");
  });

  it("refuses a config that doesn't disclose first", async () => {
    const result = await verifyCallDisclosure({
      ...ids,
      language: "FI",
      reported: { ...reported, firstMessage: "Hei!" },
    });
    expect(result).toBe("live_config_mismatch");
    expect(await callDisclosureState("org-a", "call-1")).toBe("unverified");
  });

  it("refuses a call overriding its own first message, even with a good assistant", async () => {
    const result = await verifyCallDisclosure({
      ...ids,
      language: "FI",
      reported,
      overrides: { firstMessageMode: "assistant-waits-for-user" },
    });
    expect(result).toBe("live_config_mismatch");
  });

  it("asks Vapi when the signed message describes the assistant only partly", async () => {
    m.getVapiAssistant.mockResolvedValue(reported);
    await verifyCallDisclosure({
      ...ids,
      language: "FI",
      reported: { firstMessage: reported.firstMessage },
    });
    expect(m.getVapiAssistant).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Vapi can't confirm", async () => {
    m.getVapiAssistant.mockRejectedValue(new Error("timeout"));
    expect(await verifyCallDisclosure({ ...ids, language: "FI" })).toBe("unverifiable");
  });

  it("fails closed when the result can't be stored", async () => {
    m.redisSetFails = true;
    expect(await verifyCallDisclosure({ ...ids, language: "FI", reported })).toBe("unverifiable");
  });

  it("tells a call never checked apart from Redis being down", async () => {
    expect(await callDisclosureState("org-a", "never")).toBe("unverified");
    await verifyCallDisclosure({ ...ids, language: "FI", reported });
    m.redisGetFails = true;
    expect(await callDisclosureState("org-a", "call-1")).toBe("unknown");
  });

  it("a check in one organization doesn't verify the same call id in another", async () => {
    await verifyCallDisclosure({ ...ids, language: "FI", reported });
    expect(await callDisclosureState("org-b", "call-1")).toBe("unverified");
  });
});
