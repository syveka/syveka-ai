import type React from "react";
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
  usageFails: false,
  entFails: false,
  auditRows: [] as Array<Record<string, unknown>>,
  auditFails: false,
  auditWhere: null as Record<string, unknown> | null,
  requirePermission: vi.fn(async () => ({ orgId: "org-1", userId: "u1", role: "OWNER" })),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getLocale: vi.fn(async () => state.locale),
    getFormatter: vi.fn(async () => ({ dateTime: (at: Date) => at.toISOString() })),
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
  getEntitlements: vi.fn(async () => {
    if (state.entFails) throw new Error("db down");
    return state.ent;
  }),
  getMonthUsage: vi.fn(async () => {
    if (state.usageFails) throw new Error("db down");
    return state.billable;
  }),
}));
vi.mock("@/server/db/tenant", () => {
  const voiceAssistant = {
    findFirst: vi.fn(async () => state.assistant),
    count: vi.fn(async () => 0),
  };
  return {
    tenantDb: vi.fn(() => ({
      voiceAssistant,
      auditLog: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (state.auditFails) throw new Error("db down");
          state.auditWhere = where;
          return state.auditRows;
        }),
      },
    })),
    unscopedPrisma: { voiceCall: { findMany: vi.fn(async () => []) } },
  };
});
vi.mock("@/server/integrations/redis", () => ({ redis: {} }));
vi.mock("@/components/voice/assistant-form", () => ({
  AssistantForm: ({
    statusPanel,
    recordingStatus,
  }: {
    statusPanel?: React.ReactNode;
    recordingStatus?: React.ReactNode;
  }) => (
    <>
      {statusPanel}
      {recordingStatus}
    </>
  ),
}));
// Its own suite renders it. Here: what the real page hands it, on each visit.
vi.mock("@/components/voice/recording-status-panel", () => ({
  RecordingStatusPanel: (props: Record<string, unknown>) => (
    <pre data-testid="recording">{JSON.stringify(props)}</pre>
  ),
}));
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
  recordingEnabled: null as boolean | null,
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
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

beforeEach(() => {
  state.locale = "en";
  state.assistant = readyAssistant();
  state.ent = { plan: "PRO", voiceAssistants: 3, voiceMinutesMonth: 500, readOnly: false };
  state.live = goodLive();
  state.liveFails = false;
  state.liveUrls = [];
  state.billable = 0;
  state.usageFails = false;
  state.entFails = false;
  state.requirePermission.mockClear();
  state.notFound.mockClear();
  vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01,EN@2000-01-01,AR@2000-01-01");
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
      () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01"),
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

  it.each([
    ["the live settings can't be read", "syncUnverifiable", () => (state.liveFails = true)],
    ["usage can't be read", "usageUnverifiable", () => (state.usageFails = true)],
    ["the plan can't be read", "usageUnverifiable", () => (state.entFails = true)],
  ])("doesn't claim calls are blocked when only %s", async (_name, key, arrange) => {
    arrange();
    const html = decode(await render());
    expect(html).toContain(text("en").summaryUnverified);
    expect(html).not.toContain(text("en").summaryBlocked);
    expect(html).not.toContain(text("en").summaryReady);
    expect(html).toContain(text("en")[key].action);
  });

  it("a check that couldn't run doesn't soften a real blocker", async () => {
    state.liveFails = true;
    state.ent.readOnly = true;
    const html = decode(await render());
    expect(html).toContain(text("en").summaryBlocked);
  });

  it.each(["en", "fi", "ar"] as const)(
    "%s names the activate button by the label it really has",
    (locale) => {
      const label = MESSAGES[locale].voice.activate;
      expect(text(locale).notSynced.action).toContain(label);
      expect(text(locale).inactive.action).toContain(label);
    },
  );

  it.each(["en", "fi", "ar"] as const)(
    "%s points billing actions at the owner, since other roles can't do them",
    (locale) => {
      const owner = { en: "owner", fi: "omistaja", ar: "مالك" }[locale];
      for (const key of ["noMinutes", "minutesUsed", "readOnly"]) {
        expect(text(locale)[key].action).toContain(owner);
      }
    },
  );

  it("is a labelled region with a real heading, and the notice declares its language", async () => {
    const html = await render();
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby="voice-readiness-title"');
    expect(html).toMatch(/id="voice-readiness-title"[^>]*role="heading"[^>]*aria-level="2"/);
    expect(html).toContain('lang="en"');
  });

  it("asks for a number now once connected, and after connecting if not yet", async () => {
    state.assistant = { ...readyAssistant(), phoneNumber: null };
    let html = decode(await render());
    expect(html).toContain(text("en").noPhoneNumber.action);
    expect(html).not.toContain(text("en").noPhoneNumber.actionOnceConnected);

    state.assistant = { ...readyAssistant(), phoneNumber: null, vapiAssistantId: null };
    html = decode(await render());
    expect(html).toContain(text("en").noPhoneNumber.actionOnceConnected);
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
      "usageUnverifiable",
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

describe("recording, each time the page is opened", () => {
  const event = (action: string, seconds: number, after: Record<string, unknown>) => ({
    action,
    createdAt: new Date(Date.now() - 600_000 + seconds * 1000),
    after,
  });
  const STARTED = "voice_assistant.recording_sync_started";
  const APPLIED = "voice_assistant.recording_sync_applied";
  const FAILED = "voice_assistant.sync_failed";
  const shown = async () => {
    const html = (await render()).replace(/&quot;/g, '"');
    const json = /<pre data-testid="recording">(.*?)<\/pre>/.exec(html)![1]!;
    return JSON.parse(json) as Record<string, unknown>;
  };

  beforeEach(() => {
    state.auditRows = [];
    state.auditFails = false;
    state.auditWhere = null;
    state.live = goodLive();
    state.liveFails = false;
    state.assistant = { ...readyAssistant(), recordingEnabled: false };
  });

  it("still shows a failed sync on a later visit, though the setting reads off", async () => {
    state.auditRows = [
      event(STARTED, 0, { attempt: "a", recordingEnabled: true }),
      event(APPLIED, 1, { attempt: "a" }),
      event(STARTED, 100, { attempt: "b", recordingEnabled: false }),
      event(FAILED, 101, { attempt: "b" }),
    ];
    const props = await shown();
    expect(props).toMatchObject({
      kind: "failed",
      requested: false,
      lastAccepted: { enabled: true },
    });
  });

  it("shows acceptance only after a retry succeeds", async () => {
    state.auditRows = [
      event(STARTED, 0, { attempt: "a", recordingEnabled: false }),
      event(FAILED, 1, { attempt: "a" }),
      event(STARTED, 100, { attempt: "b", recordingEnabled: false }),
      event(APPLIED, 101, { attempt: "b" }),
    ];
    expect(await shown()).toMatchObject({ kind: "applied", lastAccepted: { enabled: false } });
  });

  it("doesn't take the saved setting as proof when nothing records a send", async () => {
    expect(await shown()).toMatchObject({ kind: "uncertain", requested: false });
  });

  it("says it can't tell when the record can't be read, not that all is well", async () => {
    state.auditFails = true;
    expect(await shown()).toMatchObject({ kind: "unreadable" });
  });

  it("shows what Vapi itself reports when that differs", async () => {
    state.auditRows = [
      event(STARTED, 0, { attempt: "a", recordingEnabled: false }),
      event(APPLIED, 1, { attempt: "a" }),
    ];
    state.live = { ...goodLive(), artifactPlan: { recordingEnabled: true } };
    expect(await shown()).toMatchObject({ kind: "mismatch", reportedByVapi: true });
  });

  it("shows an assistant never set here as unknown, with what Vapi reports", async () => {
    state.assistant = readyAssistant();
    state.live = { ...goodLive(), artifactPlan: { recordingEnabled: true } };
    expect(await shown()).toMatchObject({
      kind: "needsReview",
      requested: null,
      reportedByVapi: true,
    });
    expect(state.auditWhere).toBeNull();
  });

  it("reads only this organization's rows, for this assistant", async () => {
    await shown();
    expect(state.auditWhere).toMatchObject({
      organizationId: "org-1",
      resourceType: "voice_assistant",
      resourceId: "a1",
    });
  });

  it("reports an out-of-date sync when a dashboard edit let calls run longer", async () => {
    state.live = { ...goodLive(), maxDurationSeconds: 3600 };
    const html = decode(await render());
    expect(html).toContain(text("en").syncOutdated.title);
  });

  it("isn't troubled by the 15 minutes each sync asks for", async () => {
    state.live = { ...goodLive(), maxDurationSeconds: 900 };
    const html = decode(await render());
    expect(html).not.toContain(text("en").syncOutdated.title);
  });
});
