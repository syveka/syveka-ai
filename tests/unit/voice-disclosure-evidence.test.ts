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
const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const m = vi.hoisted(() => ({
  store: new Map<string, string>(),
  failedKeys: [] as string[],
  failWrites: false,
  failedWrites: [] as string[],
  minutes: 1000,
  liveAssistant: {} as Record<string, unknown>,
  callRecord: null as Record<string, unknown> | null,
  callRecordStatus: 200,
  callList: [] as unknown[],
  unsettled: [] as unknown[],
  fetchFails: false,
  assistantFails: false,
  controlFails: false,
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
      findFirst: vi.fn(async () => m.existingRow ?? m.rows[0] ?? null),
      findMany: vi.fn(async (args: { where: { postCallProcessedAt?: null } }) =>
        args.where.postCallProcessedAt === null ? m.unsettled : [],
      ),
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
      if (m.failWrites || m.failedWrites.some((k) => key.startsWith(k))) {
        throw new Error("redis down");
      }
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
  getEntitlements: async () => ({ voiceMinutesMonth: m.minutes, readOnly: false }),
}));

import { POST } from "@/app/api/v1/voice/webhook/route";
import { unscopedPrisma } from "@/server/db/tenant";
import { redis } from "@/server/integrations/redis";
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
const start = (extra: Record<string, unknown> = {}) =>
  signed({ type: "status-update", status: "in-progress", call: CALL, ...extra });
const report = (messages?: unknown[], startedAt: string | null = minutesAgo(5)) =>
  signed({
    type: "end-of-call-report",
    call: CALL,
    endedReason: "customer-ended-call",
    durationSeconds: 60,
    ...(startedAt ? { startedAt } : {}),
    ...(messages ? { artifact: { messages, recordingUrl: "https://r/1" } } : {}),
  });
const toolCall = (messages?: unknown[], startedAt: string | null = minutesAgo(1)) =>
  signed({
    type: "tool-calls",
    call: { ...CALL, ...(startedAt ? { startedAt } : {}) },
    ...(messages ? { artifact: { messages } } : {}),
    toolCallList: [{ id: "t1", function: { name: "bookMeeting", arguments: "{}" } }],
  });
const liveCall = { id: "call-1", assistantId: VAPI_ASSISTANT, status: "in-progress" };
/** Began just now, so a read of its assistant can still stand for its start. */
const justStarted = () => ({ ...liveCall, startedAt: new Date().toISOString() });
const endedCall = (messages?: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "call-1",
  assistantId: VAPI_ASSISTANT,
  status: "ended",
  startedAt: minutesAgo(120),
  endedAt: minutesAgo(117),
  cost: 0.2,
  ...(messages ? { artifact: { messages } } : {}),
  ...extra,
});

const kept = () => m.upsert.mock.calls.length > 0 || m.enqueue.mock.calls.length > 0;

beforeEach(() => {
  m.store.clear();
  m.failedKeys = [];
  m.failWrites = false;
  m.failedWrites = [];
  m.minutes = 1000;
  m.liveAssistant = GOOD_CONFIG;
  m.callRecord = justStarted();
  m.unsettled = [];
  m.callRecordStatus = 200;
  m.callList = [];
  m.fetchFails = false;
  m.assistantFails = false;
  m.controlFails = false;
  m.rows = [];
  m.existingRow = null;
  m.assistantFetches = 0;
  m.controlCalls = 0;
  vi.clearAllMocks();
  vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01,EN@2000-01-01,AR@2000-01-01");
  vi.stubEnv("VAPI_API_KEY", "test-key");
  vi.stubEnv("VAPI_WEBHOOK_SECRET", "test-secret-of-sixteen-chars");
  vi.stubEnv("VAPI_WEBHOOK_CREDENTIAL_ID", "cred-1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === CONTROL) {
        m.controlCalls++;
        return new Response("{}", { status: m.controlFails ? 500 : 200 });
      }
      if (m.fetchFails) throw new Error("network");
      if (url.includes("/assistant/")) {
        m.assistantFetches++;
        if (m.assistantFails) throw new Error("network");
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

  it("a tool call on a call that spoke something else is refused, then ends the call", async () => {
    const res = await POST(toolCall(SPOKE_NO_NOTICE));
    expect(m.executeTool).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      results: [{ message: { endCallAfterSpokenEnabled: true } }],
    });
    // A running call's record may be incomplete, so its report makes the lasting decision.
    expect(m.store.has(REFUSED_KEY)).toBe(false);
    await POST(report(SPOKE_NO_NOTICE));
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
    ["a greeting and no notice", "مرحبا كيف حالك"],
  ])("refuses %s", async (_name, text) => {
    await POST(report([spoken(text)]));
    expect(kept()).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  it.each([
    ["another language's notice, after a language edit", spokenDisclosure("EN") as string],
    ["part of the notice, cut short", NOTICE.slice(0, NOTICE.indexOf(" ", 10))],
  ])("keeps nothing, and refuses nothing for good, for %s", async (_name, text) => {
    await POST(report([spoken(text)]));
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
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

  it("treats malformed entries as no evidence, not as a refusal", async () => {
    m.callRecord = endedCall();
    const res = await POST(
      report([null, 7, { role: "bot" }, { role: "bot", message: 5 }] as unknown[]),
    );
    expect(res.status).toBe(200);
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("treats a provider record with a malformed list as no evidence, not as a refusal", async () => {
    m.callRecord = endedCall(undefined, { artifact: { messages: "not a list" } });
    const res = await POST(report());
    expect(res.status).toBe(200);
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("a report with recording off, whose recording URL is null, is still read", async () => {
    const res = await POST(
      signed({
        type: "end-of-call-report",
        call: CALL,
        endedReason: "customer-ended-call",
        durationSeconds: 60,
        startedAt: minutesAgo(5),
        artifact: { messages: SPOKE_NOTICE, recordingUrl: null },
      }),
    );
    expect(res.status).toBe(200);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("an unapproved language isn't kept, whatever was said", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01");
    await POST(report(SPOKE_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.has(NOTICE_KEY)).toBe(false);
  });

  it("a setting missing for a while, as in a deploy, doesn't lose a good call for good", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "");
    await POST(report(SPOKE_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "AR@2000-01-01");
    m.callList = [endedCall(SPOKE_NOTICE)];
    expect((await reconcileVoiceCalls({ now: NOW })).discovered).toBe(1);
  });

  it("approving a language after a call began doesn't vouch for that call", async () => {
    // The report's call began 5 minutes ago and the reconciled one 2 hours ago.
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `AR@${minutesAgo(4)}`);
    await POST(report(SPOKE_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.has(NOTICE_KEY)).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
    m.callList = [endedCall(SPOKE_NOTICE)];
    expect((await reconcileVoiceCalls({ now: NOW })).discovered).toBe(0);
    expect(kept()).toBe(false);
  });

  it("judges a report by the earliest time Vapi states for its call", async () => {
    // Created before the approval and started after it: the earlier time decides.
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `AR@${minutesAgo(5.5)}`);
    const res = await POST(
      signed({
        type: "end-of-call-report",
        call: { ...CALL, createdAt: minutesAgo(6) },
        endedReason: "customer-ended-call",
        durationSeconds: 60,
        startedAt: minutesAgo(5),
        artifact: { messages: SPOKE_NOTICE, recordingUrl: null },
      }),
    );
    expect(res.status).toBe(200);
    expect(kept()).toBe(false);
  });

  it("a call begun after its language's approval is kept as before", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `AR@${minutesAgo(6)}`);
    await POST(report(SPOKE_NOTICE));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a tool call from a call begun before the approval runs no tool", async () => {
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `AR@${minutesAgo(0.5)}`);
    const res = await POST(toolCall(SPOKE_NOTICE));
    expect(JSON.stringify(await res.json())).toContain("disclosure_not_verified");
    expect(m.executeTool).not.toHaveBeenCalled();
  });

  it("reads a notice Vapi split across entries", async () => {
    const cut = NOTICE.indexOf(" ", 10);
    await POST(report([spoken(NOTICE.slice(0, cut), 0.5), spoken(NOTICE.slice(cut + 1), 2)]));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("doesn't join speech across something the caller said", async () => {
    const cut = NOTICE.indexOf(" ", 10);
    await POST(
      report([
        spoken(NOTICE.slice(0, cut), 0.5),
        { role: "user", message: "نعم", time: 1, endTime: 2, secondsFromStart: 1 },
        spoken(NOTICE.slice(cut + 1), 2),
      ]),
    );
    expect(kept()).toBe(false);
  });

  it("a caller talking first doesn't change what the assistant opened with", async () => {
    await POST(
      report([
        { role: "user", message: "ألو", time: 1, endTime: 2, secondsFromStart: 0.1 },
        spoken(`${NOTICE} مرحبا`, 0.5),
      ]),
    );
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("ignores tashkeel a transcript adds", async () => {
    await POST(report([spoken(NOTICE.replace(/([\u0621-\u064A])/u, "$1\u064E"))]));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("needs the notice to end at a word", async () => {
    await POST(report([spoken(`${NOTICE.replace(/[.،؟!]+$/u, "")}ات مرحبا`)]));
    expect(kept()).toBe(false);
  });

  it.each([
    ["none", undefined],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["text", "0"],
  ])("can't say when a message's time is %s", async (_name, secondsFromStart) => {
    m.callRecordStatus = 404;
    await POST(report([{ ...spoken(`${NOTICE} مرحبا`), secondsFromStart }]));
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("another assistant speaking first can't say either way, and doesn't help", async () => {
    m.callRecordStatus = 404;
    await POST(
      report([
        { ...spoken("مرحبا", 0.1), assistantId: "vapi-assistant-of-org-b" },
        spoken(`${NOTICE} مرحبا`, 0.5),
      ]),
    );
    expect(kept()).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });
});

/** A start whose own signed message says the call began just now. */
const startNow = () => start({ call: { ...CALL, startedAt: new Date().toISOString() } });

describe("a start that arrives after its call ended", () => {
  const nothingWritten = () => {
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.store.has(NOTICE_KEY)).toBe(false);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  };

  it("doesn't read today's configuration, or write anything", async () => {
    m.callRecord = endedCall();
    const res = await POST(start());
    expect(res.status).toBe(200);
    expect(m.assistantFetches).toBe(0);
    expect(m.controlCalls).toBe(0);
    nothingWritten();
  });

  it("doesn't vouch through the assistant its own signed body carries, when replayed", async () => {
    m.callRecord = endedCall();
    await POST(start({ assistant: GOOD_CONFIG }));
    nothingWritten();
  });

  it("can't rescue a call whose report has already shown no evidence", async () => {
    m.callRecord = endedCall();
    await POST(report());
    expect(kept()).toBe(false);
    await POST(start());
    await POST(report());
    await reconcileVoiceCalls({ now: NOW });
    expect(kept()).toBe(false);
    nothingWritten();
  });

  it("recognizes an ended call by its end time alone", async () => {
    m.callRecord = { ...liveCall, endedAt: minutesAgo(1) };
    await POST(start());
    nothingWritten();
  });

  it.each([
    ["Vapi can't answer", () => (m.fetchFails = true)],
    ["Vapi has no such call", () => (m.callRecordStatus = 404)],
    ["the record is about another call", () => (m.callRecord = { ...liveCall, id: "other" })],
    [
      "the record names another assistant",
      () => (m.callRecord = { ...liveCall, assistantId: "vapi-assistant-of-org-b" }),
    ],
    [
      "the record has no status",
      () => (m.callRecord = { id: "call-1", assistantId: VAPI_ASSISTANT }),
    ],
    [
      "the record's status isn't one of a running call",
      () => (m.callRecord = { ...justStarted(), status: "not-found" }),
    ],
  ])("hangs up, as Syveka's own ending and no finding, when %s", async (_name, arrange) => {
    arrange();
    const res = await POST(startNow());
    expect(res.status).toBe(200);
    expect(m.controlCalls).toBe(1);
    expect(m.assistantFetches).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.store.has(NOTICE_KEY)).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("ended");
  });

  it("a call Syveka ended this way isn't kept or billed, even with the notice on record", async () => {
    m.fetchFails = true;
    await POST(startNow());
    m.fetchFails = false;
    await POST(report(SPOKE_NOTICE));
    expect(kept()).toBe(false);
  });

  it.each([
    ["says it began long ago", () => start({ call: { ...CALL, startedAt: minutesAgo(30) } })],
    ["doesn't say when it began", () => start()],
  ])("can't claim to have ended a call whose start %s", async (_name, delivery) => {
    m.fetchFails = true;
    const res = await POST(delivery());
    expect(res.status).toBe(503);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
    m.fetchFails = false;
    await POST(report(SPOKE_NOTICE));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("if that hang-up failed, nothing is recorded and the call's own record decides", async () => {
    m.callRecord = { ...justStarted(), status: "not-found" };
    const res = await POST(
      start({ call: { ...CALL, monitor: { controlUrl: "https://not-vapi.example/control" } } }),
    );
    expect(res.status).toBe(503);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
    await POST(report(SPOKE_NOTICE));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a retry of a call that already passed survives Vapi being unreachable", async () => {
    await POST(start());
    expect(m.store.has(NOTICE_KEY)).toBe(true);
    m.fetchFails = true;
    m.rows = [];
    const res = await POST(start());
    expect(res.status).toBe(200);
    expect(m.controlCalls).toBe(0);
  });

  it("a confirmed call's replayed start takes no slot once the call has ended", async () => {
    await POST(toolCall(SPOKE_NOTICE));
    expect(m.store.has(NOTICE_KEY)).toBe(true);
    m.callRecord = endedCall();
    await POST(start());
    expect(m.upsert).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("a report that shows no notice is still refused after such a start", async () => {
    m.callRecord = endedCall();
    await POST(start());
    await POST(report(SPOKE_NO_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });
});

describe("a start that arrives late, while its call still runs", () => {
  const runningLate = (messages?: unknown[]) => ({
    ...liveCall,
    startedAt: minutesAgo(5),
    ...(messages ? { artifact: { messages } } : {}),
  });

  it("isn't vouched for by the assistant as it is now", async () => {
    m.callRecord = runningLate();
    const res = await POST(start());
    expect(res.status).toBe(200);
    expect(m.assistantFetches).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.store.has(NOTICE_KEY)).toBe(false);
    expect(m.controlCalls).toBe(0);
  });

  it("then a report showing something else is refused, not kept", async () => {
    m.callRecord = runningLate();
    await POST(start());
    await POST(report(SPOKE_NO_NOTICE));
    expect(kept()).toBe(false);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  it("is admitted when what the call has said shows the notice", async () => {
    m.callRecord = runningLate(SPOKE_NOTICE);
    await POST(start());
    expect(m.store.has(NOTICE_KEY)).toBe(true);
    expect(m.upsert).toHaveBeenCalledTimes(1);
  });

  it("is hung up when what the call has said is something else, and its report decides", async () => {
    m.callRecord = runningLate(SPOKE_NO_NOTICE);
    await POST(start());
    expect(m.controlCalls).toBe(1);
    expect(m.upsert).not.toHaveBeenCalled();
    // A running call's record may be missing its opening, so that isn't a lasting finding.
    expect(m.store.has(REFUSED_KEY)).toBe(false);
    m.callRecord = endedCall();
    await POST(report(SPOKE_NOTICE));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("asks again when that hang-up fails", async () => {
    m.callRecord = runningLate(SPOKE_NO_NOTICE);
    m.controlFails = true;
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("is still held to the limits when nothing can say yet", async () => {
    m.callRecord = runningLate();
    m.minutes = 0;
    await POST(start());
    expect(m.controlCalls).toBe(1);
    expect(m.store.get(REFUSED_KEY)).toBe("ended");
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("takes a slot, but writes no row, when nothing can say yet", async () => {
    m.callRecord = runningLate();
    await POST(start());
    expect(redis.eval).toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("asks again, writing nothing, when its confirmation can't be stored", async () => {
    m.callRecord = runningLate(SPOKE_NOTICE);
    m.failedWrites = ["voice:disclosure-ok"];
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it("is a notice refusal when its own signed message shows a bad configuration", async () => {
    m.callRecord = runningLate();
    await POST(start({ assistant: BAD_CONFIG }));
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
    expect(m.controlCalls).toBe(1);
  });

  it.each([
    [25, 1],
    [35, 0],
  ])("%i seconds in, reads the assistant %i times", async (seconds, reads) => {
    m.callRecord = {
      ...liveCall,
      startedAt: new Date(Date.now() - seconds * 1000).toISOString(),
    };
    await POST(start());
    expect(m.assistantFetches).toBe(reads);
  });

  it("a call with an unreadable start time counts as late", async () => {
    m.callRecord = { ...liveCall, startedAt: "not a time" };
    await POST(start());
    expect(m.assistantFetches).toBe(0);
    expect(m.store.has(NOTICE_KEY)).toBe(false);
  });

  it("still accepts what its own signed message says about this call", async () => {
    m.callRecord = runningLate();
    await POST(start({ assistant: GOOD_CONFIG }));
    expect(m.assistantFetches).toBe(0);
    expect(m.store.has(NOTICE_KEY)).toBe(true);
  });
});

describe("checks that couldn't complete at the start aren't findings", () => {
  it("a failed read of the assistant hangs up as Syveka's own ending", async () => {
    m.assistantFails = true;
    await POST(start());
    expect(m.controlCalls).toBe(1);
    expect(m.store.get(REFUSED_KEY)).toBe("ended");
  });

  it("if that hang-up fails too, nothing is recorded and the retry decides", async () => {
    m.assistantFails = true;
    m.controlFails = true;
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
  });

  it.each([
    [
      "the language isn't approved today",
      () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01"),
    ],
    ["the setting is missing", () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "")],
  ])("hangs up without a notice refusal when %s", async (_name, arrange) => {
    arrange();
    await POST(start());
    expect(m.controlCalls).toBe(1);
    expect(m.store.get(REFUSED_KEY)).toBe("ended");
  });

  it("a real mismatch is still a notice refusal", async () => {
    m.liveAssistant = BAD_CONFIG;
    await POST(start());
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });
});

describe("older than a refusal is remembered", () => {
  const OLD = new Date(NOW.getTime() - 72 * 60 * 60_000).toISOString();

  it("a replayed report showing the notice keeps nothing", async () => {
    m.callRecordStatus = 404;
    const res = await POST(report(SPOKE_NOTICE, OLD));
    expect(res.status).toBe(200);
    expect(kept()).toBe(false);
    expect(m.store.has(NOTICE_KEY)).toBe(false);
  });

  it("Vapi's record of that old call doesn't help", async () => {
    m.callRecord = endedCall(SPOKE_NOTICE, { startedAt: OLD });
    await POST(report(SPOKE_NOTICE, OLD));
    expect(kept()).toBe(false);
  });

  it("a replayed tool call showing the notice runs nothing", async () => {
    await POST(toolCall(SPOKE_NOTICE, OLD));
    expect(m.executeTool).not.toHaveBeenCalled();
  });

  it("a report with no time at all relies on Vapi's record for one", async () => {
    m.callRecordStatus = 404;
    await POST(report(SPOKE_NOTICE, null));
    expect(kept()).toBe(false);
    m.callRecordStatus = 200;
    m.callRecord = endedCall(SPOKE_NOTICE);
    await POST(report(SPOKE_NOTICE, null));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a report in the window is evaluated, and one just past it isn't", async () => {
    const hours = (n: number) => new Date(NOW.getTime() - n * 60 * 60_000).toISOString();
    m.callRecordStatus = 404;
    await POST(report(SPOKE_NOTICE, hours(37)));
    expect(kept()).toBe(false);
    await POST(report(SPOKE_NOTICE, hours(35)));
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("a refusal that can't be remembered", () => {
  it("a call without its notice is still hung up, and the webhook retried", async () => {
    m.liveAssistant = BAD_CONFIG;
    m.failedWrites = ["voice:refused"];
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.controlCalls).toBe(1);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("a call over its limits isn't hung up with no record of why", async () => {
    m.minutes = 0;
    m.failedWrites = ["voice:refused"];
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.controlCalls).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("the same call over its limits is hung up once the record can be written", async () => {
    m.minutes = 0;
    m.failedWrites = ["voice:refused"];
    await POST(start());
    m.failedWrites = [];
    const res = await POST(start());
    expect(res.status).toBe(200);
    expect(m.controlCalls).toBe(1);
    expect(m.store.get(REFUSED_KEY)).toBe("ended");
  });

  it("a report showing something else is retried until its refusal is stored", async () => {
    m.failedWrites = ["voice:refused"];
    const res = await POST(report(SPOKE_NO_NOTICE));
    expect(res.status).toBe(503);
    expect(kept()).toBe(false);
  });
});

describe("unknown historical configuration, and delayed reports", () => {
  it("falls back to the call's own record when the report lacks its messages", async () => {
    m.callRecord = endedCall(SPOKE_NOTICE);
    await POST(report());
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    // That record is the only transcript of the call, and the summary is written from it.
    expect(m.rows[0]!.transcript).toEqual(SPOKE_NOTICE);
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
    expect(m.rows[0]!.transcript).toEqual(SPOKE_NOTICE);
  });

  describe("a call refused by limits that couldn't be hung up", () => {
    const refuseByLimits = async () => {
      m.minutes = 0;
      m.controlFails = true;
      await POST(start());
      expect(m.store.get(REFUSED_KEY)).toBe("running");
      m.minutes = 1000;
    };

    it("isn't kept without evidence when its start came too late to be checked", async () => {
      m.callRecord = { ...liveCall, startedAt: minutesAgo(5) };
      await refuseByLimits();
      expect(m.store.has(NOTICE_KEY)).toBe(false);
      m.callList = [endedCall()];
      m.callRecord = endedCall();
      const result = await reconcileVoiceCalls({ now: NOW });
      expect(result.discovered).toBe(0);
      expect(kept()).toBe(false);
    });

    it("isn't kept when its own record shows something else", async () => {
      m.callRecord = { ...liveCall, startedAt: minutesAgo(5) };
      await refuseByLimits();
      m.callList = [endedCall(SPOKE_NO_NOTICE)];
      expect((await reconcileVoiceCalls({ now: NOW })).discovered).toBe(0);
      expect(kept()).toBe(false);
    });

    it("is kept and billed when its notice passed at the start, because it really ran", async () => {
      await refuseByLimits();
      expect(m.store.has(NOTICE_KEY)).toBe(true);
      m.callList = [endedCall()];
      expect((await reconcileVoiceCalls({ now: NOW })).discovered).toBe(1);
    });
  });

  it("records a call that spoke something else as refused, for good", async () => {
    m.callList = [endedCall(SPOKE_NO_NOTICE)];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.store.get(REFUSED_KEY)).toBe("notice");
  });

  describe("known calls", () => {
    const row = {
      id: "row-1",
      organizationId: ORG,
      vapiCallId: "call-1",
      startedAt: NOW,
      durationSeconds: 60,
    };

    it("settles a known call", async () => {
      m.unsettled = [row];
      await reconcileVoiceCalls({ now: NOW });
      expect(m.enqueue).toHaveBeenCalledTimes(1);
    });

    it.each(["notice", "ended"])(
      "closes one recorded as refused (%s), so it can't be processed once that lapses",
      async (value) => {
        m.unsettled = [row];
        m.store.set(REFUSED_KEY, value);
        await reconcileVoiceCalls({ now: NOW });
        expect(m.enqueue).not.toHaveBeenCalled();
        expect(unscopedPrisma.voiceCall.updateMany).toHaveBeenCalledWith({
          where: { id: "row-1", organizationId: ORG, postCallProcessedAt: null },
          data: { postCallProcessedAt: NOW },
        });
      },
    );

    it("leaves one whose refusal can't be read", async () => {
      m.unsettled = [row];
      m.failedKeys = ["voice:refused"];
      await reconcileVoiceCalls({ now: NOW });
      expect(m.enqueue).not.toHaveBeenCalled();
      expect(unscopedPrisma.voiceCall.updateMany).not.toHaveBeenCalled();
    });

    it("still settles one that was refused but really ran", async () => {
      m.unsettled = [row];
      m.store.set(REFUSED_KEY, "running");
      await reconcileVoiceCalls({ now: NOW });
      expect(m.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  it("stops reading records when time runs out", async () => {
    m.callList = [endedCall()];
    m.callRecord = endedCall(SPOKE_NOTICE);
    const fetches = () => vi.mocked(fetch).mock.calls.length;
    const result = await reconcileVoiceCalls({ now: NOW, deadlineMs: Date.now() - 1 });
    expect(result.discovered).toBe(0);
    expect(result.unresolved).toBe(1);
    // Only the list itself: no read of the call's own record.
    expect(fetches()).toBe(1);
  });

  it("uses the run's own clock to judge a call's age", async () => {
    m.callList = [endedCall(SPOKE_NOTICE)];
    const later = new Date(NOW.getTime() + 37 * 60 * 60_000);
    expect((await reconcileVoiceCalls({ now: later })).discovered).toBe(0);
    expect(m.store.has(REFUSED_KEY)).toBe(false);
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
