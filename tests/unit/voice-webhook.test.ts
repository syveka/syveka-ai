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
      return "OK";
    }),
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
  redis: { get: mocks.redisGet, set: mocks.redisSet },
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
  mocks.voiceAssistantFindFirst.mockResolvedValue({
    id: "assistant-1",
    organizationId: "org-a",
    enabledTools: [],
    useKnowledgeBase: false,
    organization: { members: [{ userId: "owner-1" }] },
  });
});

describe("Vapi voice webhook — tenant lifecycle", () => {
  it("does not resolve an assistant for a soft-deleted organization", async () => {
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

  it("tool-calls still executes enabled tools and never touches enqueue/redis", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce({
      id: "assistant-1",
      organizationId: "org-a",
      enabledTools: ["searchKnowledgeBase"],
      useKnowledgeBase: false,
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
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });
});
