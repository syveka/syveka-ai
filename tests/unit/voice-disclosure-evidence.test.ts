import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVoiceFirstMessage, spokenDisclosure } from "@/server/ai/prompts/voice";
import type * as VapiModule from "@/server/integrations/vapi";

/**
 * A configuration read after a call started can't show what that call's caller heard. These
 * run the real webhook, gate and reconciliation. Only the signature, database, Redis, queue,
 * limits and network are faked, with synthetic data. No call or paid request is made.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const VAPI_ASSISTANT = "vapi-assistant-a";
const CONTROL = "https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/x/control";
const NOW = new Date("2026-11-20T12:00:00Z");

const m = vi.hoisted(() => ({
  store: new Map<string, string>(),
  failedKeys: [] as string[],
  failWrites: false,
  liveAssistant: {} as Record<string, unknown>,
  callRecord: null as Record<string, unknown> | null,
  callRecordStatus: 200,
  callList: [] as unknown[],
  fetchFails: false,
  upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
    m.rows.push(args.create);
    return { id: "row-1" };
  }),
  rows: [] as Array<Record<string, unknown>>,
  existingRow: null as Record<string, unknown> | null,
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
  executeTool: vi.fn(async (..._args: unknown[]) => '{"ok":true}'),
  assistantFetches: 0,
  controlCalls: 0,
}));

vi.mock("@/server/integrations/vapi", async (importOriginal) => ({
  ...(await importOriginal<typeof VapiModule>()),
  verifyVapiSignature: () => true,
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceAssistant: {
      findFirst: vi.fn(async ({ where }: { where: { vapiAssistantId?: string } }) =>
        where.vapiAssistantId === VAPI_ASSISTANT
          ? {
              id: "assistant-1",
              organizationId: ORG,
              enabledTools: ["bookMeeting", "getCalendarAvailability"],
              isActive: true,
              language: "AR",
              organization: { members: [{ userId: "owner-1" }] },
            }
          : null,
      ),
      findMany: vi.fn(async () => [
        {
          id: "assistant-1",
          organizationId: ORG,
          vapiAssistantId: VAPI_ASSISTANT,
          language: "AR",
        },
      ]),
    },
    voiceCall: {
      findFirst: vi.fn(async () => m.existingRow),
      findMany: vi.fn(async () => []),
      upsert: m.upsert,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));
vi.mock("@/server/integrations/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => {
      if (m.failedKeys.some((k) => key.startsWith(k))) throw new Error("redis down");
      return m.store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      if (m.failWrites) throw new Error("redis down");
      if (m.store.has(key) && key.startsWith("vapi:tool:")) return null;
      m.store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    decr: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _keys: string[], args: string[]) =>
      args[2] === "0" ? [-1, 0] : [1, 0],
    ),
  },
}));
vi.mock("@/server/ai/tools", () => ({ executeTool: m.executeTool }));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));
vi.mock("@/server/services/billing/entitlements", () => ({
  getMonthUsage: async () => 0,
  getEntitlements: async () => ({ voiceMinutesMonth: 1000, readOnly: false }),
}));

import { POST } from "@/app/api/v1/voice/webhook/route";
import { reconcileVoiceCalls } from "@/server/voice/reconcile-calls";

const NOTICE = spokenDisclosure("AR") as string;
const GOOD_CONFIG = {
  firstMessage: buildVoiceFirstMessage("AR", "مرحبا"),
  firstMessageMode: "assistant-speaks-first",
  firstMessageInterruptionsEnabled: false,
};
const BAD_CONFIG = { ...GOOD_CONFIG, firstMessage: "مرحبا" };
const spoken = (text: string, secondsFromStart = 0.5) => ({
  role: "bot",
  message: text,
  time: 1,
  endTime: 2,
  secondsFromStart,
});
const SPOKE_NOTICE = [
  { role: "system", message: "prompt", time: 0, secondsFromStart: 0 },
  spoken(`${NOTICE} مرحبا`),
  { role: "user", message: "أهلا", time: 3, endTime: 4, secondsFromStart: 3 },
];
const SPOKE_NO_NOTICE = [spoken("مرحبا، كيف يمكنني مساعدتك؟")];

const CALL = { id: "call-1", assistantId: VAPI_ASSISTANT, monitor: { controlUrl: CONTROL } };
const REFUSED_KEY = `voice:refused:${ORG}:call-1`;
const NOTICE_KEY = `voice:disclosure-ok:${ORG}:call-1`;

const signed = (message: Record<string, unknown>) =>
  new Request("http://localhost/api/v1/voice/webhook", {
    method: "POST",
    headers: { "x-vapi-signature": "sig" },
    body: JSON.stringify({ message }),
  });
const start = () => signed({ type: "status-update", status: "in-progress", call: CALL });
const report = (messages?: unknown[]) =>
  signed({
    type: "end-of-call-report",
    call: CALL,
    endedReason: "customer-ended-call",
    durationSeconds: 60,
    ...(messages ? { artifact: { messages, recordingUrl: "https://r/1" } } : {}),
  });
const toolCall = (messages?: unknown[]) =>
  signed({
    type: "tool-calls",
    call: CALL,
    ...(messages ? { artifact: { messages } } : {}),
    toolCallList: [{ id: "t1", function: { name: "bookMeeting", arguments: "{}" } }],
  });
const endedCall = (messages?: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "call-1",
  assistantId: VAPI_ASSISTANT,
  status: "ended",
  startedAt: "2026-11-20T10:00:00Z",
  endedAt: "2026-11-20T10:03:00Z",
  cost: 0.2,
  ...(messages ? { artifact: { messages } } : {}),
  ...extra,
});

const kept = () => m.upsert.mock.calls.length > 0 || m.enqueue.mock.calls.length > 0;

beforeEach(() => {
  m.store.clear();
  m.failedKeys = [];
  m.failWrites = false;
  m.liveAssistant = GOOD_CONFIG;
  m.callRecord = null;
  m.callRecordStatus = 200;
  m.callList = [];
  m.fetchFails = false;
  m.rows = [];
  m.existingRow = null;
  m.assistantFetches = 0;
  m.controlCalls = 0;
  vi.clearAllMocks();
  vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI,EN,AR");
  vi.stubEnv("VAPI_API_KEY", "test-key");
  vi.stubEnv("VAPI_WEBHOOK_SECRET", "test-secret-of-sixteen-chars");
  vi.stubEnv("VAPI_WEBHOOK_CREDENTIAL_ID", "cred-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === CONTROL) {
        m.controlCalls++;
        return new Response("{}");
      }
      if (m.fetchFails) throw new Error("network");
      if (url.includes("/assistant/")) {
        m.assistantFetches++;
        return new Response(JSON.stringify(m.liveAssistant));
      }
      if (url.includes("/call/")) {
        return m.callRecordStatus === 200
          ? new Response(JSON.stringify(m.callRecord))
          : new Response("{}", { status: m.callRecordStatus });
      }
      if (url.includes("/call?")) return new Response(JSON.stringify(m.callList));
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a missed start, followed by a configuration change", () => {
  it("a good configuration today doesn't vouch for a report that shows no notice", async () => {
    m.liveAssistant = GOOD_CONFIG;
    await POST(report(SPOKE_NO_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  it("isn't vouched for by today's configuration when the report shows nothing spoken", async () => {
    m.liveAssistant = GOOD_CONFIG;
    m.callRecord = endedCall();
    const res = await POST(report());
    expect(res.status).toBe(200);
    expect(kept()).toBe(false);
    expect(m.store.has(NOTICE_KEY)).toBe(false);
  });

  it("never reads today's configuration to judge a past call", async () => {
    await POST(report(SPOKE_NOTICE));
    expect(m.assistantFetches).toBe(0);
  });

  it("is kept when the call's own record shows the notice, even with today's config bad", async () => {
    m.liveAssistant = BAD_CONFIG;
    const res = await POST(report(SPOKE_NOTICE));
    expect(res.status).toBe(200);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.store.has(NOTICE_KEY)).toBe(true);
  });

  it("a tool call isn't confirmed by today's configuration", async () => {
    m.liveAssistant = GOOD_CONFIG;
    await POST(toolCall());
    expect(m.executeTool).not.toHaveBeenCalled();
    expect(m.store.has(NOTICE_KEY)).toBe(false);
  });

  it("a tool call is confirmed by what this call has already said", async () => {
    await POST(toolCall(SPOKE_NOTICE));
    expect(m.executeTool).toHaveBeenCalledTimes(1);
    expect(m.assistantFetches).toBe(0);
  });

  it("a tool call on a call that spoke something else is refused for good", async () => {
    await POST(toolCall(SPOKE_NO_NOTICE));
    expect(m.executeTool).not.toHaveBeenCalled();
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });
});

describe("what counts as evidence", () => {
  it.each([
    ["punctuation and spacing differ", `  ${NOTICE.replace(/[،.]/g, " ")}   مرحبا`],
    ["it's the opening of a longer turn", `${NOTICE} مرحبا، كيف يمكنني مساعدتك؟`],
  ])("accepts the notice when %s", async (_name, text) => {
    await POST(report([spoken(text)]));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the notice after a greeting", `مرحبا ${NOTICE}`],
    ["the wrong language's notice", spokenDisclosure("EN") as string],
    ["part of the notice", NOTICE.slice(0, 12)],
  ])("refuses %s", async (_name, text) => {
    await POST(report([spoken(text)]));
    expect(kept()).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  it("judges the earliest spoken message, whatever order the list is in", async () => {
    await POST(report([spoken(`${NOTICE} مرحبا`, 9), spoken("مرحبا", 1)]));
    expect(kept()).toBe(false);
  });

  it("isn't fooled by the caller saying the notice", async () => {
    await POST(
      report([{ role: "user", message: NOTICE, time: 1, endTime: 2, secondsFromStart: 0 }]),
    );
    expect(kept()).toBe(false);
  });

  it("ignores a spoken message from another assistant", async () => {
    await POST(report([{ ...spoken(`${NOTICE} مرحبا`), assistantId: "vapi-assistant-of-org-b" }]));
    expect(kept()).toBe(false);
  });

  it.each([
    ["a malformed list", "not a list"],
    ["malformed entries", [null, 7, { role: "bot" }, { role: "bot", message: 5 }]],
  ])("treats %s as no evidence, not as a refusal", async (_name, messages) => {
    m.callRecord = endedCall();
    await POST(report(messages as unknown[]));
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("an unapproved language isn't kept, whatever was said", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI");
    await POST(report(SPOKE_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });
});

describe("unknown historical configuration, and delayed reports", () => {
  it("falls back to the call's own record when the report lacks its messages", async () => {
    m.callRecord = endedCall(SPOKE_NOTICE);
    await POST(report());
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing, and doesn't refuse for good, when no record shows anything", async () => {
    m.callRecordStatus = 404;
    const res = await POST(report());
    expect(res.status).toBe(200);
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("asks to be retried when the provider can't answer", async () => {
    m.fetchFails = true;
    const res = await POST(report());
    expect(res.status).toBe(503);
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("a delayed report for a call admitted at its start is kept, with the marker gone", async () => {
    m.existingRow = { id: "row-1", endedAt: null, durationSeconds: null };
    m.liveAssistant = BAD_CONFIG;
    await POST(report());
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a report for a call that passed its start check is kept", async () => {
    await POST(start());
    m.liveAssistant = BAD_CONFIG;
    await POST(report());
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("refusals stay", () => {
  async function refuse() {
    m.liveAssistant = BAD_CONFIG;
    await POST(start());
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
    m.controlCalls = 0;
    m.liveAssistant = GOOD_CONFIG;
  }

  it("against a report that shows the notice", async () => {
    await refuse();
    await POST(report(SPOKE_NOTICE));
    expect(kept()).toBe(false);
  });

  it("against a replayed start", async () => {
    await refuse();
    await POST(start());
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  it("against a tool call that shows the notice", async () => {
    await refuse();
    await POST(toolCall(SPOKE_NOTICE));
    expect(m.executeTool).not.toHaveBeenCalled();
  });

  it("against reconciliation", async () => {
    await refuse();
    m.callList = [endedCall(SPOKE_NOTICE)];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();
  });
});

describe("reconciliation", () => {
  it("doesn't re-create a call because today's configuration is good", async () => {
    m.liveAssistant = GOOD_CONFIG;
    m.callList = [endedCall()];
    m.callRecord = endedCall();
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(kept()).toBe(false);
    // No evidence isn't a refusal: a later run may yet find the transcript.
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("keeps a call whose own record shows the notice, whatever today's configuration is", async () => {
    m.liveAssistant = BAD_CONFIG;
    m.callList = [endedCall(SPOKE_NOTICE)];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(1);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.assistantFetches).toBe(0);
  });

  it("reads the call's own record when the list omits its messages", async () => {
    m.callList = [endedCall()];
    m.callRecord = endedCall(SPOKE_NOTICE);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(1);
  });

  it("records a call that spoke something else as refused, for good", async () => {
    m.callList = [endedCall(SPOKE_NO_NOTICE)];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  it("leaves a call for the next run when the provider can't answer", async () => {
    m.callList = [endedCall()];
    m.callRecordStatus = 500;
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });
});

describe("Redis errors", () => {
  it.each(["voice:refused", "voice:disclosure-ok"])(
    "a report is retried and nothing kept when %s can't be read",
    async (key) => {
      m.failedKeys = [key];
      const res = await POST(report(SPOKE_NOTICE));
      expect(res.status).toBe(503);
      expect(kept()).toBe(false);
    },
  );

  it.each(["voice:refused", "voice:disclosure-ok"])(
    "reconciliation leaves a call alone when %s can't be read",
    async (key) => {
      m.failedKeys = [key];
      m.callList = [endedCall(SPOKE_NOTICE)];
      const result = await reconcileVoiceCalls({ now: NOW });
      expect(result.discovered).toBe(0);
      expect(kept()).toBe(false);
    },
  );

  it("a report is retried when its confirmation can't be stored", async () => {
    m.failWrites = true;
    const res = await POST(report(SPOKE_NOTICE));
    expect(res.status).toBe(503);
    expect(kept()).toBe(false);
  });

  it("a tool call is refused, without ending the call, when it can't be stored", async () => {
    m.failWrites = true;
    const res = await POST(toolCall(SPOKE_NOTICE));
    expect(m.executeTool).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      results: [{ toolCallId: "t1", result: JSON.stringify({ error: "limits_unavailable" }) }],
    });
  });
});

describe("cross-tenant records", () => {
  it("a provider record about another call is no evidence", async () => {
    m.callRecord = endedCall(SPOKE_NOTICE, { id: "another-call" });
    await POST(report());
    expect(kept()).toBe(false);
  });

  it("a provider record naming another assistant is no evidence", async () => {
    m.callRecord = endedCall(SPOKE_NOTICE, { assistantId: "vapi-assistant-of-org-b" });
    await POST(report());
    expect(kept()).toBe(false);
  });

  it("another organization's confirmation or refusal for the same call id doesn't count", async () => {
    m.store.set(`voice:disclosure-ok:${OTHER_ORG}:call-1`, "1");
    m.store.set(`voice:refused:${OTHER_ORG}:call-1`, "notice");
    m.callRecordStatus = 404;
    await POST(report());
    expect(kept()).toBe(false);
    m.store.clear();
    m.store.set(`voice:refused:${OTHER_ORG}:call-1`, "notice");
    await POST(report(SPOKE_NOTICE));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("reconciliation ignores a listed call of another assistant", async () => {
    m.callList = [endedCall(SPOKE_NOTICE, { assistantId: "vapi-assistant-of-org-b" })];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();
  });
});
