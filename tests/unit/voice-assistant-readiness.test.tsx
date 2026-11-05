import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVoiceFirstMessage, spokenDisclosure } from "@/server/ai/prompts/voice";

/**
 * The readiness panel on the assistant settings page, through the real page, service, gate and
 * translations. Vapi, the database and entitlements are faked, with synthetic data.
 */
const SECRET = "vapi-private-assistant-id";
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") };

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "fi" | "ar",
  assistant: null as Record<string, unknown> | null,
  ent: { plan: "PRO", voiceAssistants: 3, voiceMinutesMonth: 500, readOnly: false },
  live: {} as Record<string, unknown>,
  liveFails: false,
  liveUrls: [] as string[],
  billable: 0,
  requirePermission: vi.fn(async () => ({ orgId: "org-1", userId: "u1", role: "OWNER" })),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getLocale: vi.fn(async () => state.locale),
    getTranslations: vi.fn(async (namespace?: string) =>
      createTranslator({
        locale: state.locale,
        messages: MESSAGES[state.locale],
        namespace,
      } as never),
    ),
  };
});
vi.mock("next/navigation", () => ({ notFound: state.notFound }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: state.requirePermission }));
vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => state.ent),
  getMonthUsage: vi.fn(async () => state.billable),
}));
vi.mock("@/server/db/tenant", () => {
  const voiceAssistant = {
    findFirst: vi.fn(async () => state.assistant),
    count: vi.fn(async () => 0),
  };
  return {
    tenantDb: vi.fn(() => ({ voiceAssistant })),
    unscopedPrisma: { voiceCall: { findMany: vi.fn(async () => []) } },
  };
});
vi.mock("@/server/integrations/redis", () => ({ redis: {} }));
vi.mock("@/components/voice/assistant-form", () => ({ AssistantForm: () => null }));
vi.mock("@/components/billing/plan-display", () => ({
  PLAN_NAMES: { FREE: "Free", PRO: "Pro" },
  formatCount: (_l: string, n: number) => String(n),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

import AssistantPage from "@/app/[locale]/(app)/voice/[assistantId]/page";

const readyAssistant = (language = "EN") => ({
  id: "a1",
  name: "Reception",
  language,
  voiceProvider: "azure",
  voiceId: null,
  firstMessage: "Hello",
  systemPrompt: "Help callers.",
  enabledTools: [],
  useKnowledgeBase: false,
  transferNumber: null,
  vapiAssistantId: SECRET,
  phoneNumber: "+358401234567",
  isActive: true,
});
const goodLive = (language = "EN") => ({
  firstMessage: buildVoiceFirstMessage(language, "Hello"),
  firstMessageMode: "assistant-speaks-first",
  firstMessageInterruptionsEnabled: false,
});

async function render(): Promise<string> {
  const element = await AssistantPage({ params: Promise.resolve({ assistantId: "a1" }) });
  return renderToStaticMarkup(element as React.ReactElement);
}
const text = (locale: "en" | "fi" | "ar") => MESSAGES[locale].voice.readiness;
const decode = (html: string) => html.replace(/&#x27;/g, "'");

beforeEach(() => {
  state.locale = "en";
  state.assistant = readyAssistant();
  state.ent = { plan: "PRO", voiceAssistants: 3, voiceMinutesMonth: 500, readOnly: false };
  state.live = goodLive();
  state.liveFails = false;
  state.liveUrls = [];
  state.billable = 0;
  state.requirePermission.mockClear();
  state.notFound.mockClear();
  vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI,EN,AR");
  vi.stubEnv("VAPI_API_KEY", "test-private-key");
  vi.stubEnv("VAPI_WEBHOOK_SECRET", "test-secret-of-sixteen-chars");
  vi.stubEnv("VAPI_WEBHOOK_CREDENTIAL_ID", "cred-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      state.liveUrls.push(`${init?.method ?? "GET"} ${url}`);
      if (state.liveFails) throw new Error(`boom ${SECRET}`);
      return new Response(JSON.stringify(state.live));
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("what the panel reports", () => {
  it("says nothing is blocking when nothing is, without claiming a call works", async () => {
    const html = decode(await render());
    expect(html).toContain(text("en").summaryReady);
    expect(html).not.toContain(text("en").summaryBlocked);
    expect(html).toContain(text("en").noticeApproved);
  });

  it.each([
    [
      "the notice isn't approved",
      "noticeAwaitingApproval",
      () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI"),
    ],
    [
      "no language is approved",
      "noticeAwaitingApproval",
      () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", ""),
    ],
    [
      "it was never connected",
      "notSynced",
      () => (state.assistant = { ...readyAssistant(), vapiAssistantId: null }),
    ],
    ["the live settings are old", "syncOutdated", () => (state.live = { firstMessage: "Hello" })],
    ["the live settings can't be read", "syncUnverifiable", () => (state.liveFails = true)],
    [
      "there's no number",
      "noPhoneNumber",
      () => (state.assistant = { ...readyAssistant(), phoneNumber: null }),
    ],
    [
      "it's switched off",
      "inactive",
      () => (state.assistant = { ...readyAssistant(), isActive: false }),
    ],
    ["the plan has no minutes", "noMinutes", () => (state.ent.voiceMinutesMonth = 0)],
    ["the minutes are used", "minutesUsed", () => (state.billable = 500)],
    ["the workspace is read-only", "readOnly", () => (state.ent.readOnly = true)],
    [
      "voice isn't set up",
      "voiceNotSetUp",
      () => {
        // The test setup skips environment validation, which would hide a missing key.
        vi.stubEnv("SKIP_ENV_VALIDATION", "");
        vi.stubEnv("VAPI_API_KEY", "");
      },
    ],
  ])("names the problem and the action when %s", async (_name, key, arrange) => {
    arrange();
    const html = decode(await render());
    expect(html).toContain(text("en").summaryBlocked);
    expect(html).toContain(text("en")[key].title);
    expect(html).toContain(text("en")[key].action);
  });

  it("marks an unapproved notice as awaiting approval, and still shows it", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "");
    const html = decode(await render());
    expect(html).toContain(text("en").noticeAwaiting);
    expect(html).toContain(spokenDisclosure("EN"));
  });

  it("only reads from Vapi, and not at all without a connected assistant", async () => {
    await render();
    expect(state.liveUrls).toHaveLength(1);
    expect(state.liveUrls[0]).toMatch(/^GET /);
    state.liveUrls.length = 0;
    state.assistant = { ...readyAssistant(), vapiAssistantId: null };
    await render();
    expect(state.liveUrls).toHaveLength(0);
  });
});

describe("what it never shows", () => {
  it("exposes no configuration, ids, provider errors or setting names", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "");
    state.liveFails = true;
    const html = await render();
    for (const leak of [
      SECRET,
      "test-private-key",
      "boom",
      "VOICE_DISCLOSURE_APPROVED_LANGUAGES",
      "VAPI_",
    ]) {
      expect(html).not.toContain(leak);
    }
  });

  it("no translation names an environment variable or a provider's internals", () => {
    for (const locale of ["en", "fi", "ar"] as const) {
      expect(JSON.stringify(text(locale))).not.toMatch(/[A-Z]{3,}_[A-Z]+|artifactPlan|Vapi/);
    }
  });
});

describe("access", () => {
  it("requires the same permission as the rest of the page, before anything else", async () => {
    await render();
    expect(state.requirePermission).toHaveBeenCalledWith("voice:configure");
  });

  it("refused access reads nothing from Vapi", async () => {
    state.requirePermission.mockRejectedValueOnce(new Error("forbidden"));
    await expect(render()).rejects.toThrow("forbidden");
    expect(state.liveUrls).toHaveLength(0);
  });

  it("another organization's assistant is not found, and reads nothing from Vapi", async () => {
    state.assistant = null;
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.liveUrls).toHaveLength(0);
  });
});

describe("languages and layout", () => {
  it.each(["en", "fi", "ar"] as const)("%s has every status translated", (locale) => {
    const t = text(locale);
    for (const key of [
      "voiceNotSetUp",
      "noticeAwaitingApproval",
      "notSynced",
      "syncOutdated",
      "syncUnverifiable",
      "noPhoneNumber",
      "inactive",
      "noMinutes",
      "minutesUsed",
      "readOnly",
    ]) {
      expect(t[key].title.length).toBeGreaterThan(3);
      expect(t[key].action.length).toBeGreaterThan(3);
    }
    if (locale !== "en") {
      expect(t.summaryBlocked).not.toBe(text("en").summaryBlocked);
      expect(t.notSynced.action).not.toBe(text("en").notSynced.action);
    }
  });

  it("renders in Arabic, with the notice setting its own direction", async () => {
    state.locale = "ar";
    state.assistant = { ...readyAssistant("AR"), phoneNumber: null };
    state.live = goodLive("AR");
    const html = await render();
    expect(html).toContain(text("ar").noPhoneNumber.title);
    expect(html).toContain('dir="auto"');
    expect(html).toContain(spokenDisclosure("AR"));
  });

  it("uses direction-neutral, wrapping layout classes", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/components/voice/assistant-readiness-panel.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d|text-(left|right)/);
    expect(source).toContain("flex-wrap");
    expect(source).toContain("break-words");
    expect(source).toContain("text-start");
  });
});
