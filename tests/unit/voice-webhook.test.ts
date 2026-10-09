import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const callOrder: string[] = [];
  const counters = new Map<string, number>();
  return {
    callOrder,
    verifyVapiSignature: vi.fn(() => true),
    voiceAssistantFindFirst: vi.fn(async () => ({
      id: "assistant-1",
      organizationId: "org-a",
      enabledTools: [] as string[],
      useKnowledgeBase: false,
      isActive: true,
      organization: { members: [{ userId: "owner-1" }] },
    })),
    voiceCallUpsert: vi.fn(async (..._args: unknown[]) => {
      callOrder.push("upsert");
      return {};
    }),
    executeTool: vi.fn(async (..._args: unknown[]) => "" as string),
    getMonthUsage: vi.fn(async () => 0),
    getEntitlements: vi.fn(async () => ({ voiceMinutesMonth: 1000 })),
    enqueue: vi.fn(async (..._args: unknown[]) => {
      callOrder.push("enqueue");
    }),
    redisGet: vi.fn(async () => null as string | null),
    redisSet: vi.fn(async (..._args: unknown[]) => {
      callOrder.push("redis-set");
      return "OK" as string | null;
    }),
    redisDel: vi.fn(async (..._args: unknown[]) => 1),
    // In-memory INCR/DECR counters so per-call write caps behave like Redis.
    counters,
    voiceCallFindFirst: vi.fn(
      async (..._args: unknown[]) => null as Record<string, unknown> | null,
    ),
    redisIncr: vi.fn(async (key: string) => {
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return counters.get(key)!;
    }),
    redisDecr: vi.fn(async (key: string) => {
      counters.set(key, (counters.get(key) ?? 0) - 1);
      return counters.get(key)!;
    }),
    redisExpire: vi.fn(async (..._args: unknown[]) => 1),
  };
});

vi.mock("@/server/integrations/vapi", () => ({
  verifyVapiSignature: mocks.verifyVapiSignature,
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceAssistant: { findFirst: mocks.voiceAssistantFindFirst },
    voiceCall: { upsert: mocks.voiceCallUpsert, findFirst: mocks.voiceCallFindFirst },
  },
}));
vi.mock("@/server/ai/tools", () => ({ executeTool: mocks.executeTool }));
vi.mock("@/server/services/billing/entitlements", () => ({
  getMonthUsage: mocks.getMonthUsage,
  getEntitlements: mocks.getEntitlements,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/server/integrations/redis", () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
    incr: mocks.redisIncr,
    decr: mocks.redisDecr,
    expire: mocks.redisExpire,
  },
}));

import { POST } from "@/app/api/v1/voice/webhook/route";

function eocrRequest(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/v1/voice/webhook", {
    method: "POST",
    headers: { "x-vapi-signature": "sig" },
    body: JSON.stringify({
      message: {
        type: "end-of-call-report",
        call: { id: "call-1", assistantId: "assistant-1" },
        endedReason: "customer-ended-call",
        durationSeconds: 42,
        cost: 0.5,
        ...overrides,
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callOrder.length = 0;
  mocks.counters.clear();
  mocks.redisGet.mockResolvedValue(null);
});

describe("Vapi voice webhook — end-of-call-report replay protection", () => {
  it("first valid delivery: persists the call, enqueues once with the deduplication ID, then writes the marker", async () => {
    const response = await POST(eocrRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(mocks.voiceCallUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "post-call",
      { vapiCallId: "call-1", orgId: "org-a" },
      { deduplicationId: "vapi-eocr-org-a-call-1" },
    );

    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    const [key, value, opts] = mocks.redisSet.mock.calls[0]!;
    expect(key).toBe("vapi:eocr:org-a:call-1");
    expect(value).toBe("1");
    expect((opts as { ex: number }).ex).toBeGreaterThanOrEqual(60 * 60 * 24);

    // The durable marker must be written only after enqueue has succeeded.
    expect(mocks.callOrder).toEqual(["upsert", "enqueue", "redis-set"]);
  });

  it("records the full call result even when the in-progress status update was never received", async () => {
    await POST(
      eocrRequest({
        artifact: { messages: [{ role: "user", message: "hi" }], recordingUrl: "https://r/1" },
      }),
    );

    const args = mocks.voiceCallUpsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    // post-call bills from durationSeconds and summarizes the transcript.
    expect(args.create).toMatchObject({
      organizationId: "org-a",
      status: "COMPLETED",
      durationSeconds: 42,
      costCents: 50,
      endedReason: "customer-ended-call",
      transcript: [{ role: "user", message: "hi" }],
      recordingUrl: "https://r/1",
    });
    expect(args.create.endedAt).toBeInstanceOf(Date);
    expect(args.update).toMatchObject({ durationSeconds: 42, costCents: 50 });
  });

  it("duplicate delivery (marker already present): persistence stays safe, no re-enqueue, duplicate response", async () => {
    mocks.redisGet.mockResolvedValue("1");
    const response = await POST(eocrRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: true });

    expect(mocks.voiceCallUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("enqueue failure: marker is not written, request fails retryably, and a later retry is not suppressed", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("qstash unavailable"));
    const first = await POST(eocrRequest());
    expect(first.status).toBe(500);
    expect(mocks.redisSet).not.toHaveBeenCalled();

    // A later retry: redis.get still returns null (no marker was ever written), so
    // the retry must be allowed to enqueue again, not silently suppressed.
    mocks.enqueue.mockResolvedValueOnce(undefined);
    const retry = await POST(eocrRequest());
    expect(retry.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
  });
});

describe("Vapi voice webhook — unrelated message types are unchanged", () => {
  it("status-update still upserts the in-progress call and never touches enqueue/redis", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/voice/webhook", {
        method: "POST",
        headers: { "x-vapi-signature": "sig" },
        body: JSON.stringify({
          message: {
            type: "status-update",
            status: "in-progress",
            call: { id: "call-2", assistantId: "assistant-1" },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.voiceCallUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.redisGet).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("tool-calls still executes enabled tools and never enqueues", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce({
      id: "assistant-1",
      organizationId: "org-a",
      enabledTools: ["searchKnowledgeBase"],
      useKnowledgeBase: false,
      isActive: true,
      organization: { members: [{ userId: "owner-1" }] },
    });
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));

    const response = await POST(
      new Request("http://localhost/api/v1/voice/webhook", {
        method: "POST",
        headers: { "x-vapi-signature": "sig" },
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            call: { id: "call-3", assistantId: "assistant-1" },
            toolCallList: [{ id: "tc-1", name: "searchKnowledgeBase", arguments: {} }],
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toEqual([{ toolCallId: "tc-1", result: JSON.stringify({ ok: true }) }]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });
});

/**
 * The Vapi HMAC signs the body only (no timestamp), so a captured tool-calls
 * request stays valid forever. Each tool-call id must run at most once.
 */
describe("Vapi voice webhook — tool-calls replay protection", () => {
  const enabledAssistant = (organizationId = "org-a") => ({
    id: `assistant-${organizationId}`,
    organizationId,
    enabledTools: ["bookMeeting"],
    useKnowledgeBase: false,
    isActive: true,
    organization: { members: [{ userId: "owner-1" }] },
  });

  function toolCallsRequest(toolCallIds: string[]) {
    return new Request("http://localhost/api/v1/voice/webhook", {
      method: "POST",
      headers: { "x-vapi-signature": "sig" },
      body: JSON.stringify({
        message: {
          type: "tool-calls",
          call: { id: "call-5", assistantId: "assistant-1" },
          toolCallList: toolCallIds.map((id) => ({
            id,
            name: "bookMeeting",
            arguments: { title: "x", startsAt: "2026-01-01T10:00:00Z" },
          })),
        },
      }),
    });
  }

  it("refuses CRM contact search for an assistant saved before it was removed from caller tools", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce({
      ...enabledAssistant(),
      enabledTools: ["searchContacts", "bookMeeting"],
    });
    const request = new Request("http://localhost/api/v1/voice/webhook", {
      method: "POST",
      headers: { "x-vapi-signature": "sig" },
      body: JSON.stringify({
        message: {
          type: "tool-calls",
          call: { id: "call-6", assistantId: "assistant-1" },
          toolCallList: [{ id: "tc-search", name: "searchContacts", arguments: { query: "ma" } }],
        },
      }),
    });

    const body = await (await POST(request)).json();

    expect(body.results).toEqual([
      { toolCallId: "tc-search", result: JSON.stringify({ error: "tool_not_enabled" }) },
    ]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("first delivery claims the tool-call id atomically (NX, 24h) and executes it", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(enabledAssistant());
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ booked: true }));

    const body = await (await POST(toolCallsRequest(["tc-1"]))).json();

    expect(body.results).toEqual([
      { toolCallId: "tc-1", result: JSON.stringify({ booked: true }) },
    ]);
    expect(mocks.redisSet).toHaveBeenCalledWith("vapi:tool:org-a:tc-1", "1", {
      nx: true,
      ex: 60 * 60 * 24,
    });
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
  });

  it("a replayed (already claimed) tool call is refused without executing or returning tool output", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(enabledAssistant());
    mocks.redisSet.mockResolvedValueOnce(null);

    const res = await POST(toolCallsRequest(["tc-1"]));

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { toolCallId: "tc-1", result: JSON.stringify({ error: "duplicate_tool_call" }) },
    ]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("only the replayed id is refused when a request mixes new and already-run tool calls", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(enabledAssistant());
    mocks.redisSet.mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ booked: true }));

    const body = await (await POST(toolCallsRequest(["tc-old", "tc-new"]))).json();

    expect(body.results).toEqual([
      { toolCallId: "tc-old", result: JSON.stringify({ error: "duplicate_tool_call" }) },
      { toolCallId: "tc-new", result: JSON.stringify({ booked: true }) },
    ]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when execution throws, so a legitimate retry can run the tool", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(enabledAssistant());
    mocks.executeTool.mockRejectedValueOnce(new Error("db down"));

    await expect(POST(toolCallsRequest(["tc-1"]))).rejects.toThrow("db down");
    expect(mocks.redisDel).toHaveBeenCalledWith("vapi:tool:org-a:tc-1");

    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(enabledAssistant());
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ booked: true }));
    const body = await (await POST(toolCallsRequest(["tc-1"]))).json();
    expect(body.results[0].result).toBe(JSON.stringify({ booked: true }));
  });

  it("scopes the claim per organization: the same tool-call id in another org is claimed separately", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(enabledAssistant("org-b"));
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ booked: true }));

    await POST(toolCallsRequest(["tc-1"]));

    expect(mocks.redisSet).toHaveBeenCalledWith("vapi:tool:org-b:tc-1", "1", expect.anything());
  });

  it("an invalid HMAC is rejected before any claim or execution", async () => {
    mocks.verifyVapiSignature.mockReturnValueOnce(false);

    const res = await POST(toolCallsRequest(["tc-1"]));

    expect(res.status).toBe(401);
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("never claims (or burns) an id for a tool that is not enabled", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce({
      ...enabledAssistant(),
      enabledTools: [],
    });

    const body = await (await POST(toolCallsRequest(["tc-1"]))).json();

    expect(body.results[0].result).toBe(JSON.stringify({ error: "tool_not_enabled" }));
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });
});

describe("Vapi voice webhook — soft-deleted organization", () => {
  it("looks up the assistant only in non-deleted orgs and ingests nothing when none matches", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(null as never);

    const response = await POST(eocrRequest());

    expect(response.status).toBe(404);
    expect(mocks.voiceAssistantFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vapiAssistantId: "assistant-1", organization: { deletedAt: null } },
      }),
    );
    expect(mocks.voiceCallUpsert).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("a tool-calls request for a soft-deleted org's assistant claims and executes nothing", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(null as never);

    const response = await POST(
      new Request("http://localhost/api/v1/voice/webhook", {
        method: "POST",
        headers: { "x-vapi-signature": "sig" },
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            call: { id: "call-6", assistantId: "assistant-1" },
            toolCallList: [{ id: "tc-1", name: "bookMeeting", arguments: {} }],
          },
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});

describe("Vapi voice webhook — deactivated assistant refuses tool-call writes (rollback safety)", () => {
  it("refuses every tool call for a deactivated assistant, even an already-enabled one, without executing any of them", async () => {
    // Regression for a proven gap: previously the webhook never checked
    // isActive at all, so a deactivated assistant already mid-call could
    // still execute CRM/calendar/booking writes -- "disabled" was cosmetic.
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce({
      id: "assistant-1",
      organizationId: "org-a",
      enabledTools: ["searchKnowledgeBase", "bookMeeting"],
      useKnowledgeBase: false,
      isActive: false,
      organization: { members: [{ userId: "owner-1" }] },
    });

    const response = await POST(
      new Request("http://localhost/api/v1/voice/webhook", {
        method: "POST",
        headers: { "x-vapi-signature": "sig" },
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            call: { id: "call-4", assistantId: "assistant-1" },
            toolCallList: [
              { id: "tc-1", name: "searchKnowledgeBase", arguments: {} },
              {
                id: "tc-2",
                name: "bookMeeting",
                arguments: { title: "x", startsAt: "2026-01-01T10:00:00Z" },
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toEqual([
      { toolCallId: "tc-1", result: JSON.stringify({ error: "assistant_disabled" }) },
      { toolCallId: "tc-2", result: JSON.stringify({ error: "assistant_disabled" }) },
    ]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});

function writeAssistant(organizationId = "org-a") {
  return {
    id: `assistant-${organizationId}`,
    organizationId,
    enabledTools: [
      "bookMeeting",
      "createContact",
      "logActivity",
      "getCalendarAvailability",
      "searchKnowledgeBase",
    ],
    useKnowledgeBase: true,
    isActive: true,
    organization: { members: [{ userId: "owner-1" }] },
  };
}

function toolRequest(callId: string, calls: Array<{ id: string; name: string }>) {
  return new Request("http://localhost/api/v1/voice/webhook", {
    method: "POST",
    headers: { "x-vapi-signature": "sig" },
    body: JSON.stringify({
      message: {
        type: "tool-calls",
        call: { id: callId, assistantId: "assistant-1" },
        toolCallList: calls.map((c) => ({ ...c, arguments: {} })),
      },
    }),
  });
}

async function runTools(
  callId: string,
  calls: Array<{ id: string; name: string }>,
  organizationId = "org-a",
) {
  mocks.voiceAssistantFindFirst.mockResolvedValueOnce(writeAssistant(organizationId));
  const res = await POST(toolRequest(callId, calls));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Array<{ toolCallId: string; result: string }> };
  return body.results.map((r) => r.result);
}

const OK = JSON.stringify({ ok: true });
const err = (error: string) => JSON.stringify({ error });

/**
 * One caller (or a script) must not be able to book every offered slot or create
 * unlimited contacts/activities within a single call.
 */
describe("Vapi voice webhook — per-call write caps", () => {
  beforeEach(() => {
    mocks.executeTool.mockResolvedValue(OK);
  });

  it("refuses the third booking in the same call without executing it", async () => {
    expect(await runTools("call-7", [{ id: "b1", name: "bookMeeting" }])).toEqual([OK]);
    expect(await runTools("call-7", [{ id: "b2", name: "bookMeeting" }])).toEqual([OK]);
    expect(await runTools("call-7", [{ id: "b3", name: "bookMeeting" }])).toEqual([
      err("call_write_limit"),
    ]);

    expect(mocks.executeTool).toHaveBeenCalledTimes(2);
    expect(mocks.redisIncr).toHaveBeenCalledWith("vapi:callcap:org-a:call-7:bookMeeting");
    // TTL is set once, on the first increment, and outlives the 15-minute max call.
    expect(mocks.redisExpire).toHaveBeenCalledTimes(1);
    expect(mocks.redisExpire).toHaveBeenCalledWith(
      "vapi:callcap:org-a:call-7:bookMeeting",
      60 * 60 * 2,
    );
  });

  it("caps writes requested together in one tool-calls batch", async () => {
    const results = await runTools("call-7", [
      { id: "b1", name: "bookMeeting" },
      { id: "b2", name: "bookMeeting" },
      { id: "b3", name: "bookMeeting" },
    ]);

    expect(results.filter((r) => r === OK)).toHaveLength(2);
    expect(results.filter((r) => r === err("call_write_limit"))).toHaveLength(1);
    expect(mocks.executeTool).toHaveBeenCalledTimes(2);
  });

  it("applies the default cap per tool: createContact 2, logActivity 5", async () => {
    const contacts = await runTools(
      "call-7",
      ["c1", "c2", "c3"].map((id) => ({ id, name: "createContact" })),
    );
    expect(contacts.filter((r) => r === OK)).toHaveLength(2);

    const activities = await runTools(
      "call-7",
      ["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => ({ id, name: "logActivity" })),
    );
    expect(activities.filter((r) => r === OK)).toHaveLength(5);
    expect(activities.filter((r) => r === err("call_write_limit"))).toHaveLength(1);
  });

  it("never caps read tools", async () => {
    const reads = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      name: i % 2 ? "searchKnowledgeBase" : "getCalendarAvailability",
    }));
    const results = await runTools("call-7", reads);

    expect(results).toEqual(reads.map(() => OK));
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.voiceCallFindFirst).not.toHaveBeenCalled();
  });

  it("does not affect a different call in the same org", async () => {
    await runTools("call-7", [
      { id: "b1", name: "bookMeeting" },
      { id: "b2", name: "bookMeeting" },
    ]);
    expect(await runTools("call-8", [{ id: "b3", name: "bookMeeting" }])).toEqual([OK]);
    expect(mocks.redisIncr).toHaveBeenLastCalledWith("vapi:callcap:org-a:call-8:bookMeeting");
  });

  it("does not affect the same call id in a different org", async () => {
    await runTools("call-7", [
      { id: "b1", name: "bookMeeting" },
      { id: "b2", name: "bookMeeting" },
    ]);
    expect(await runTools("call-7", [{ id: "b3", name: "bookMeeting" }], "org-b")).toEqual([OK]);
    expect(mocks.redisIncr).toHaveBeenLastCalledWith("vapi:callcap:org-b:call-7:bookMeeting");
  });

  it("a write whose execution throws does not consume the cap", async () => {
    mocks.executeTool.mockRejectedValueOnce(new Error("calendar down"));
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(writeAssistant());
    await expect(POST(toolRequest("call-7", [{ id: "b1", name: "bookMeeting" }]))).rejects.toThrow(
      "calendar down",
    );
    expect(mocks.redisDecr).toHaveBeenCalledWith("vapi:callcap:org-a:call-7:bookMeeting");

    expect(await runTools("call-7", [{ id: "b2", name: "bookMeeting" }])).toEqual([OK]);
    expect(await runTools("call-7", [{ id: "b3", name: "bookMeeting" }])).toEqual([OK]);
    expect(await runTools("call-7", [{ id: "b4", name: "bookMeeting" }])).toEqual([
      err("call_write_limit"),
    ]);
  });

  it("a write refused by the cap keeps its tool-call claim but gives the slot back", async () => {
    await runTools("call-7", [
      { id: "b1", name: "bookMeeting" },
      { id: "b2", name: "bookMeeting" },
    ]);
    expect(await runTools("call-7", [{ id: "b3", name: "bookMeeting" }])).toEqual([
      err("call_write_limit"),
    ]);

    expect(mocks.counters.get("vapi:callcap:org-a:call-7:bookMeeting")).toBe(2);
    expect(mocks.redisDel).not.toHaveBeenCalledWith("vapi:tool:org-a:b3");
  });

  it("fails closed for writes when Redis cannot count them; reads still run", async () => {
    mocks.redisIncr.mockRejectedValueOnce(new Error("redis unavailable"));

    const results = await runTools("call-7", [
      { id: "b1", name: "bookMeeting" },
      { id: "r1", name: "searchKnowledgeBase" },
    ]);

    expect(results).toEqual([err("call_write_limit_unavailable"), OK]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.executeTool).toHaveBeenCalledWith(
      expect.anything(),
      "searchKnowledgeBase",
      expect.anything(),
    );
    // The claim is released so a retry can run once Redis is back.
    expect(mocks.redisDel).toHaveBeenCalledWith("vapi:tool:org-a:b1");
  });

  it("refuses writes without a call id (nothing to key the cap on); reads still run", async () => {
    const results = await runTools("", [
      { id: "b1", name: "bookMeeting" },
      { id: "r1", name: "searchKnowledgeBase" },
    ]);

    expect(results).toEqual([err("call_required"), OK]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
  });
});

/**
 * The tool-call claim expires after 24h, so a captured signed request replayed later
 * would re-run its writes. The durable VoiceCall row refuses writes for an ended call.
 */
describe("Vapi voice webhook — writes refused after the call has ended", () => {
  beforeEach(() => {
    mocks.executeTool.mockResolvedValue(OK);
  });

  it("refuses a mutating tool for an ended call; reads in the same request still run", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce({
      endedAt: new Date("2026-01-01T10:15:00Z"),
      status: "COMPLETED",
    });

    const results = await runTools("call-7", [
      { id: "b1", name: "bookMeeting" },
      { id: "c1", name: "createContact" },
      { id: "r1", name: "searchKnowledgeBase" },
    ]);

    expect(results).toEqual([err("call_ended"), err("call_ended"), OK]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.voiceCallFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-a", vapiCallId: "call-7" } }),
    );
    expect(mocks.redisIncr).not.toHaveBeenCalled();
  });

  it("treats any terminal status as ended even without endedAt", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce({ endedAt: null, status: "TRANSFERRED" });

    expect(await runTools("call-7", [{ id: "b1", name: "bookMeeting" }])).toEqual([
      err("call_ended"),
    ]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("allows writes for an in-progress call", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce({ endedAt: null, status: "IN_PROGRESS" });

    expect(await runTools("call-7", [{ id: "b1", name: "bookMeeting" }])).toEqual([OK]);
  });

  it("allows writes when no call row exists (the in-progress status update can be missed)", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce(null);

    expect(await runTools("call-7", [{ id: "b1", name: "bookMeeting" }])).toEqual([OK]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
  });
});

describe("Vapi voice webhook — end-of-call-report replay does not overwrite call details", () => {
  it("a replay for an already-ended call leaves the recorded details untouched", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce({
      endedAt: new Date("2026-01-01T10:15:00Z"),
      postCallProcessedAt: null,
    });
    mocks.redisGet.mockResolvedValue("1");

    const res = await POST(eocrRequest({ durationSeconds: 1, cost: 999 }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(mocks.voiceCallUpsert).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.voiceCallFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-a", vapiCallId: "call-1" } }),
    );
  });

  it("a replay after post-call processing overwrites and re-enqueues nothing, even after the marker expired", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce({
      endedAt: new Date("2026-01-01T10:15:00Z"),
      postCallProcessedAt: new Date("2026-01-01T10:16:00Z"),
    });

    const res = await POST(eocrRequest({ durationSeconds: 1, cost: 999 }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(mocks.voiceCallUpsert).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("a retry after a failed enqueue keeps the recorded details but can still enqueue", async () => {
    mocks.voiceCallFindFirst.mockResolvedValueOnce({
      endedAt: new Date("2026-01-01T10:15:00Z"),
      postCallProcessedAt: null,
    });

    const res = await POST(eocrRequest());

    expect(res.status).toBe(200);
    expect(mocks.voiceCallUpsert).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
