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
  vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI,EN,AR");
});
afterEach(() => vi.unstubAllEnvs());

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
      VOICE_DISCLOSURE_APPROVED_LANGUAGES: " FI , EN",
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
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI");
    const result = await verifyCallDisclosure({ ...ids, language: "AR", reported });
    expect(result).toBe("language_not_approved");
    expect(await callDisclosureState("org-a", "call-1")).toBe("unverified");
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
