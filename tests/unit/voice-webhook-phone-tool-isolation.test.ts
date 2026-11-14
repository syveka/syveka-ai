import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A phone caller is anonymous. Whatever an assistant stored, the webhook must only run
 * tools on the phone allowlist (#255, #302): never searchKnowledgeBase (every document of
 * the organization) and never searchContacts (CRM contact data), and only ever as the
 * assistant's own organization. This base's webhook parses the flat tool-call shape
 * ({ id, name, arguments }); the nested spec shape is rejected before any tool runs (it is
 * accepted from #282 on main). Ports the webhook-level cases of #302 to the flat shape and
 * adds negative cases. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  verifyVapiSignature: vi.fn(() => true),
  voiceAssistantFindFirst: vi.fn(),
  voiceCallUpsert: vi.fn(async () => ({})),
  executeTool: vi.fn(async (..._args: unknown[]) => JSON.stringify({ ok: true })),
  getMonthUsage: vi.fn(async () => 0),
  getEntitlements: vi.fn(async () => ({ voiceMinutesMonth: 1000 })),
  enqueue: vi.fn(async () => undefined),
  redisGet: vi.fn(async () => null as string | null),
  redisSet: vi.fn(async () => "OK" as string | null),
  redisDel: vi.fn(async () => 1),
}));

vi.mock("@/server/integrations/vapi", () => ({ verifyVapiSignature: mocks.verifyVapiSignature }));
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

const NOT_ENABLED = JSON.stringify({ error: "tool_not_enabled" });

const toolCalls = (toolCallList: unknown[], extra: Record<string, unknown> = {}) =>
  POST(
    new Request("http://localhost/api/v1/voice/webhook", {
      method: "POST",
      headers: { "x-vapi-signature": "sig" },
      body: JSON.stringify({
        message: {
          type: "tool-calls",
          call: { id: "call-iso", assistantId: "assistant-1" },
          toolCallList,
          ...extra,
        },
      }),
    }),
  );

const assistantWith = (settings: Record<string, unknown>) =>
  mocks.voiceAssistantFindFirst.mockResolvedValueOnce({
    id: "assistant-1",
    organizationId: "org-a",
    isActive: true,
    organization: { members: [{ userId: "owner-1" }] },
    ...settings,
  });

const kbCall = { id: "tc-kb", name: "searchKnowledgeBase", arguments: { query: "salary table" } };
const contactsCall = { id: "tc-crm", name: "searchContacts", arguments: { query: "a" } };

beforeEach(() => {
  vi.clearAllMocks();
  // Drop any queued one-shot assistant a refused request never consumed.
  mocks.voiceAssistantFindFirst.mockReset();
  mocks.verifyVapiSignature.mockReturnValue(true);
  mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.redisSet.mockResolvedValue("OK");
});

describe("phone callers can't reach the knowledge base or the CRM", () => {
  it("an assistant saved with the previous defaults is refused the knowledge base; its other tools still run", async () => {
    assistantWith({
      enabledTools: ["searchKnowledgeBase", "getCalendarAvailability"],
      useKnowledgeBase: true,
    });
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ slots: [] }));

    const body = await (
      await toolCalls([kbCall, { id: "tc-cal", name: "getCalendarAvailability", arguments: {} }])
    ).json();

    expect(body.results).toEqual([
      { toolCallId: "tc-kb", result: NOT_ENABLED },
      { toolCallId: "tc-cal", result: JSON.stringify({ slots: [] }) },
    ]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", actorType: "voice_ai" }),
      "getCalendarAvailability",
      {},
    );
  });

  it("contact search is refused even for an assistant that had opted in to it", async () => {
    assistantWith({ enabledTools: ["searchContacts", "createContact"], useKnowledgeBase: false });

    const body = await (await toolCalls([contactsCall])).json();

    expect(body.results).toEqual([{ toolCallId: "tc-crm", result: NOT_ENABLED }]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("a knowledge-base call is refused even when the assistant was never offered it", async () => {
    assistantWith({ enabledTools: [], useKnowledgeBase: false });

    const body = await (await toolCalls([kbCall])).json();

    expect(body.results).toEqual([{ toolCallId: "tc-kb", result: NOT_ENABLED }]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["null", { enabledTools: null, useKnowledgeBase: null }],
    ["malformed", { enabledTools: "searchKnowledgeBase", useKnowledgeBase: "true" }],
    [
      "non-string entries",
      { enabledTools: [42, { name: "searchContacts" }], useKnowledgeBase: true },
    ],
  ])("%s stored settings allow no tool", async (_, settings) => {
    assistantWith(settings);

    const body = await (await toolCalls([kbCall, contactsCall])).json();

    expect(body.results.map((r: { result: string }) => r.result)).toEqual([
      NOT_ENABLED,
      NOT_ENABLED,
    ]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("an unknown or internal tool name is refused", async () => {
    assistantWith({ enabledTools: ["getCalendarAvailability"], useKnowledgeBase: false });

    const body = await (
      await toolCalls([
        { id: "t1", name: "deleteContact", arguments: {} },
        { id: "t2", name: "listMembers", arguments: {} },
        { id: "t3", name: "", arguments: {} },
      ])
    ).json();

    expect(body.results.map((r: { result: string }) => r.result)).toEqual([
      NOT_ENABLED,
      NOT_ENABLED,
      NOT_ENABLED,
    ]);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("tools run only as the assistant's own organization, whatever the payload claims", async () => {
    assistantWith({ enabledTools: ["getCalendarAvailability"], useKnowledgeBase: false });

    await toolCalls(
      [{ id: "tc-cal", name: "getCalendarAvailability", arguments: { orgId: "org-b" } }],
      { orgId: "org-b", organizationId: "org-b" },
    );

    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", actorType: "voice_ai" }),
      "getCalendarAvailability",
      expect.anything(),
    );
  });
});

describe("requests that never reach a tool", () => {
  it("an invalid signature is refused before the assistant lookup", async () => {
    mocks.verifyVapiSignature.mockReturnValueOnce(false);

    const res = await toolCalls([kbCall]);

    expect(res.status).toBe(401);
    expect(mocks.voiceAssistantFindFirst).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("an unknown assistant is refused", async () => {
    mocks.voiceAssistantFindFirst.mockResolvedValueOnce(null);

    const res = await toolCalls([kbCall]);

    expect(res.status).toBe(404);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("the nested spec shape is rejected on this base before the assistant lookup", async () => {
    const res = await toolCalls([
      { id: "tc-kb", type: "function", function: { name: "searchKnowledgeBase", arguments: "{}" } },
    ]);

    expect(res.status).toBe(400);
    expect(mocks.voiceAssistantFindFirst).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("an inactive assistant runs nothing", async () => {
    assistantWith({ enabledTools: ["getCalendarAvailability"], isActive: false });

    const body = await (
      await toolCalls([{ id: "tc-cal", name: "getCalendarAvailability", arguments: {} }])
    ).json();

    expect(body.results[0].result).toBe(JSON.stringify({ error: "assistant_disabled" }));
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});
