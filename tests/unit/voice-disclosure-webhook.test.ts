import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVoiceFirstMessage } from "@/server/ai/prompts/voice";
import type * as VapiModule from "@/server/integrations/vapi";
import { toVapiPayload, type VapiAssistantConfig } from "@/server/integrations/vapi";
import { liveConfigDisclosesFirst } from "@/server/voice/disclosure-gate";

/**
 * The real notice gate through the real webhook. Only the signature, the database, Redis and
 * network calls are faked, so a mismatch between what syncing sends and what the gate expects
 * (which would end every call) fails here. No call or paid request is made.
 */
const CONTROL = "https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/x/control";

const m = vi.hoisted(() => ({
  store: new Map<string, string>(),
  redisDown: false,
  redisGetDown: false,
  language: "AR",
  liveAssistant: {} as Record<string, unknown>,
  fetchFails: false,
  upsert: vi.fn(async (..._args: unknown[]) => ({ id: "row-1" })),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
  executeTool: vi.fn(async (..._args: unknown[]) => '{"booked":true}'),
  controlCalls: 0,
  existingRow: null as Record<string, unknown> | null,
  noticeKeyDown: false,
  refusalKeyDown: false,
}));

vi.mock("@/server/integrations/vapi", async (importOriginal) => ({
  ...(await importOriginal<typeof VapiModule>()),
  verifyVapiSignature: () => true,
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceAssistant: {
      findFirst: vi.fn(async () => ({
        id: "assistant-1",
        organizationId: "org-a",
        enabledTools: ["bookMeeting", "getCalendarAvailability"],
        isActive: true,
        language: m.language,
        organization: { members: [{ userId: "owner-1" }] },
      })),
    },
    voiceCall: {
      findFirst: vi.fn(async () => m.existingRow),
      upsert: m.upsert,
      findMany: vi.fn(async () => []),
    },
  },
}));
vi.mock("@/server/integrations/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => {
      if (m.redisDown || m.redisGetDown) throw new Error("redis down");
      if (m.noticeKeyDown && key.startsWith("voice:disclosure-ok")) throw new Error("redis down");
      if (m.refusalKeyDown && key.startsWith("voice:refused")) throw new Error("redis down");
      return m.store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      if (m.redisDown) throw new Error("redis down");
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

function syncedAssistant(language: string): Record<string, unknown> {
  const config: VapiAssistantConfig = {
    name: "Test",
    firstMessage: buildVoiceFirstMessage(language, "Hei!"),
    systemPrompt: "Test",
    language: language.toLowerCase() as VapiAssistantConfig["language"],
    voiceProvider: "azure",
    voiceId: null,
    serverUrl: "https://staging.invalid/webhook",
    serverCredentialId: "cred-1",
    tools: [],
    transferNumber: null,
    maxDurationSeconds: 900,
  };
  return toVapiPayload(config) as unknown as Record<string, unknown>;
}

const signed = (message: Record<string, unknown>) =>
  new Request("http://localhost/api/v1/voice/webhook", {
    method: "POST",
    headers: { "x-vapi-signature": "sig" },
    body: JSON.stringify({ message }),
  });
const CALL = {
  id: "call-1",
  assistantId: "vapi-1",
  get createdAt() {
    return new Date().toISOString();
  },
  monitor: { controlUrl: CONTROL },
};
const start = (extra: Record<string, unknown> = {}) =>
  signed({ type: "status-update", status: "in-progress", call: CALL, ...extra });
const toolCall = (name = "bookMeeting", messages?: unknown[]) =>
  signed({
    type: "tool-calls",
    call: CALL,
    ...(messages ? { artifact: { messages } } : {}),
    toolCallList: [{ id: "t1", function: { name, arguments: "{}" } }],
  });
const report = () =>
  signed({
    type: "end-of-call-report",
    call: CALL,
    endedReason: "customer-ended-call",
    durationSeconds: 60,
    artifact: { messages: [{ role: "user", message: "secret" }], recordingUrl: "https://r/1" },
  });

const vapiAnswer = (url: string) =>
  new Response(
    JSON.stringify(
      url.includes("/call/")
        ? {
            id: CALL.id,
            assistantId: CALL.assistantId,
            status: "in-progress",
            startedAt: new Date().toISOString(),
          }
        : m.liveAssistant,
    ),
  );

beforeEach(() => {
  m.store.clear();
  m.redisDown = false;
  m.redisGetDown = false;
  m.language = "AR";
  m.liveAssistant = syncedAssistant("AR");
  m.fetchFails = false;
  m.controlCalls = 0;
  m.existingRow = null;
  m.noticeKeyDown = false;
  m.refusalKeyDown = false;
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
        return new Response("{}");
      }
      if (m.fetchFails) throw new Error("network");
      return vapiAnswer(url);
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

describe("what syncing sends is what the gate accepts", () => {
  it.each(["FI", "EN", "AR"])("%s", (language) => {
    expect(
      liveConfigDisclosesFirst(language, syncedAssistant(language) as Record<string, never>),
    ).toBe(true);
  });

  it("another language's notice isn't accepted", () => {
    expect(liveConfigDisclosesFirst("AR", syncedAssistant("EN") as Record<string, never>)).toBe(
      false,
    );
  });

  it("asks Vapi to keep live control on, since refusing a call relies on it", () => {
    expect(syncedAssistant("FI").monitorPlan).toEqual({
      controlEnabled: true,
      controlAuthenticationEnabled: false,
    });
  });
});

describe("a correctly synced call", () => {
  it("connects, runs its tools and keeps its report", async () => {
    await POST(start());
    expect(m.controlCalls).toBe(0);
    expect(m.upsert).toHaveBeenCalledTimes(1);

    const res = await POST(toolCall());
    await expect(res.json()).resolves.toMatchObject({ results: [{ toolCallId: "t1" }] });
    expect(m.executeTool).toHaveBeenCalledTimes(1);

    await POST(report());
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("recovers a missed start from what the call has already said", async () => {
    const res = await POST(
      toolCall("bookMeeting", [
        {
          role: "bot",
          message: String(syncedAssistant("AR").firstMessage),
          time: 1,
          endTime: 2,
          secondsFromStart: 0.5,
        },
      ]),
    );
    expect(res.status).toBe(200);
    expect(m.executeTool).toHaveBeenCalledTimes(1);
  });
});

describe("a call that fails the check", () => {
  const scenarios: Array<[string, () => void]> = [
    [
      "its language isn't approved",
      () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "FI@2000-01-01"),
    ],
    ["no language is approved", () => vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", "")],
    ["the assistant was never re-synced", () => (m.liveAssistant = { firstMessage: "مرحبا" })],
    ["Vapi can't confirm", () => (m.fetchFails = true)],
    [
      "the dashboard lets the model write the opening",
      () =>
        (m.liveAssistant = {
          ...syncedAssistant("AR"),
          firstMessageMode: "assistant-speaks-first-with-model-generated-message",
        }),
    ],
  ];

  it.each(scenarios)("is hung up when %s", async (_name, arrange) => {
    arrange();
    await POST(start());
    expect(m.controlCalls).toBe(1);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("is hung up when its language was approved only after it began", async () => {
    const began = new Date(Date.now() - 20_000).toISOString();
    const approved = new Date(Date.now() - 10_000).toISOString();
    vi.stubEnv("VOICE_DISCLOSURE_APPROVED_LANGUAGES", `AR@${approved}`);
    await POST(start({ call: { ...CALL, startedAt: began } }));
    expect(m.controlCalls).toBe(1);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  // The tool path reads no configuration, so only these two scenarios can differ there.
  it.each(scenarios.slice(0, 2))("runs no tool, read or write, when %s", async (_name, arrange) => {
    arrange();
    for (const name of ["bookMeeting", "getCalendarAvailability"]) {
      const res = await POST(toolCall(name));
      const body = (await res.json()) as { results: Array<Record<string, unknown>> };
      // Spoken and then hung up, even if the status update never arrived.
      expect(body.results[0]).toMatchObject({
        message: { type: "request-failed", endCallAfterSpokenEnabled: true },
      });
      expect(body.results[0]!.error).toBe("disclosure_not_verified");
    }
    expect(m.executeTool).not.toHaveBeenCalled();
  });

  it.each(scenarios)("keeps no transcript and starts no pipeline when %s", async (_n, arrange) => {
    arrange();
    await POST(start());
    const res = await POST(report());
    expect(res.status).toBe(200);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("is refused when this call overrides the first message", async () => {
    await POST(
      start({
        call: { ...CALL, assistantOverrides: { firstMessage: "Hello, no notice here" } },
      }),
    );
    expect(m.controlCalls).toBe(1);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("asks Vapi when the signed message only partly describes the assistant", async () => {
    m.liveAssistant = { firstMessage: "مرحبا" };
    await POST(start({ assistant: { firstMessage: syncedAssistant("AR").firstMessage } }));
    expect(m.controlCalls).toBe(1);
  });
});

describe("a report for a call whose start was missed", () => {
  it("isn't kept just because the live config looks right now", async () => {
    const res = await POST(report());
    expect(res.status).toBe(200);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("retries and replays", () => {
  it("a retried start for a confirmed call survives Vapi being unreachable", async () => {
    await POST(start());
    m.upsert.mockClear();
    m.fetchFails = true;
    await POST(start());
    expect(m.controlCalls).toBe(0);
    expect(m.store.has("voice:refused:org-a:call-1")).toBe(false);
  });

  it("replaying a refused call's start changes nothing, even with the config since fixed", async () => {
    m.liveAssistant = { firstMessage: "no notice" };
    await POST(start());
    expect(m.store.get("voice:refused:org-a:call-1")).toBe("notice");
    m.controlCalls = 0;
    m.liveAssistant = syncedAssistant("AR");
    await POST(start());
    expect(m.controlCalls).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.store.get("voice:refused:org-a:call-1")).toBe("notice");
  });

  it("a notice refusal stays: fixing the config doesn't bring back its tools or report", async () => {
    m.liveAssistant = { firstMessage: "no notice" };
    await POST(start());
    m.liveAssistant = syncedAssistant("AR");
    await POST(toolCall());
    expect(m.executeTool).not.toHaveBeenCalled();
    await POST(report());
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("keeps nothing for a notice refusal whose hang-up failed", async () => {
    m.liveAssistant = { firstMessage: "no notice" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === CONTROL ? new Response("{}", { status: 500 }) : vapiAnswer(url),
      ),
    );
    await POST(start());
    expect(m.store.get("voice:refused:org-a:call-1")).toBe("notice");
    await POST(report());
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the report of a call that has a row, without asking Vapi", async () => {
    m.existingRow = { id: "row-1", endedAt: null, durationSeconds: null };
    m.fetchFails = true;
    await POST(report());
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("retries a report rather than drop it when Vapi can't answer", async () => {
    m.fetchFails = true;
    const res = await POST(report());
    expect(res.status).toBe(503);
    expect(m.store.has("voice:refused:org-a:call-1")).toBe(false);
  });

  it("a Redis blip on the refusal refuses tools without ending a confirmed call", async () => {
    await POST(start());
    m.redisGetDown = true;
    const res = await POST(toolCall());
    await expect(res.json()).resolves.toEqual({
      results: [{ toolCallId: "t1", result: JSON.stringify({ error: "limits_unavailable" }) }],
    });
  });

  it("a Redis blip on the notice refuses tools without ending a confirmed call", async () => {
    await POST(start());
    m.noticeKeyDown = true;
    const res = await POST(toolCall());
    await expect(res.json()).resolves.toEqual({
      results: [{ toolCallId: "t1", result: JSON.stringify({ error: "limits_unavailable" }) }],
    });
  });

  // A statement of what the code does in a full outage, not an endorsement: whether to hang up
  // instead is an owner decision. See "Redis read failure" in docs/voice/implementation-plan.md.
  it("in a full Redis outage a call runs on with no slot, no row and no tools", async () => {
    m.redisDown = true;
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.controlCalls).toBe(0);
    expect(m.upsert).not.toHaveBeenCalled();

    const tools = await POST(toolCall());
    await expect(tools.json()).resolves.toEqual({
      results: [{ toolCallId: "t1", result: JSON.stringify({ error: "limits_unavailable" }) }],
    });
    expect(m.executeTool).not.toHaveBeenCalled();

    expect((await POST(report())).status).toBe(503);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("decides nothing on unreadable state: a start is retried, and nothing is refused", async () => {
    await POST(start());
    m.controlCalls = 0;
    m.store.delete("voice:refused:org-a:call-1");
    m.redisGetDown = true;
    const res = await POST(start());
    expect(res.status).toBe(503);
    expect(m.controlCalls).toBe(0);
    m.redisGetDown = false;
    m.noticeKeyDown = true;
    expect((await POST(start())).status).toBe(503);
    expect(m.controlCalls).toBe(0);
    expect(m.store.has("voice:refused:org-a:call-1")).toBe(false);
  });

  it("an unreadable refusal alone is enough to wait, at the start and the report", async () => {
    m.refusalKeyDown = true;
    expect((await POST(start())).status).toBe(503);
    await POST(toolCall());
    expect(m.executeTool).not.toHaveBeenCalled();
    expect((await POST(report())).status).toBe(503);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("a report is retried when its refusal can't be read, so a refused call isn't kept", async () => {
    m.liveAssistant = { firstMessage: "no notice" };
    await POST(start());
    m.liveAssistant = syncedAssistant("AR");
    m.redisGetDown = true;
    const res = await POST(report());
    expect(res.status).toBe(503);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("when Redis is down", () => {
  it("a report is retried rather than dropped: the call may have been fine", async () => {
    await POST(start());
    m.redisGetDown = true;
    const res = await POST(report());
    expect(res.status).toBe(503);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("no tool runs, even for a call that had passed", async () => {
    await POST(start());
    m.redisGetDown = true;
    await POST(toolCall());
    expect(m.executeTool).not.toHaveBeenCalled();
  });
});
