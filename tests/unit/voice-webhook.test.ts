import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const callOrder: string[] = [];
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
  };
});

vi.mock("@/server/integrations/vapi", () => ({
  verifyVapiSignature: mocks.verifyVapiSignature,
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceAssistant: { findFirst: mocks.voiceAssistantFindFirst },
    voiceCall: { upsert: mocks.voiceCallUpsert },
  },
}));
vi.mock("@/server/ai/tools", () => ({ executeTool: mocks.executeTool }));
vi.mock("@/server/services/billing/entitlements", () => ({
  getMonthUsage: mocks.getMonthUsage,
  getEntitlements: mocks.getEntitlements,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/server/integrations/redis", () => ({
  redis: { get: mocks.redisGet, set: mocks.redisSet, del: mocks.redisDel },
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
