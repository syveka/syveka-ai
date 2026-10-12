import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an anonymous phone caller can read from the knowledge base, end to end through
 * the real webhook route and the real tool registry (executeTool, searchKnowledgeBase).
 * Mocked: the signature check, the assistant lookup, Redis, plan limits and the
 * retrieval itself, which returns a synthetic private document of the organization it
 * is asked for, like the real organization-scoped match_chunks.
 */
const m = vi.hoisted(() => ({
  assistant: null as Record<string, unknown> | null,
  retrieveChunks: vi.fn(async ({ orgId }: { orgId: string; query: string }) =>
    orgId === "org-a"
      ? [
          {
            documentId: "doc-private",
            title: "Synthetic payroll (internal)",
            content: "SYNTHETIC-PRIVATE salary table",
          },
        ]
      : [],
  ),
  claims: new Set<string>(),
}));

vi.mock("@/server/integrations/vapi", () => ({ verifyVapiSignature: () => true }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceAssistant: { findFirst: vi.fn(async () => m.assistant) },
    voiceCall: { findFirst: vi.fn(async () => null) },
  },
  tenantDb: vi.fn(),
}));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: m.retrieveChunks }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/billing/entitlements", () => ({
  getMonthUsage: vi.fn(async () => 0),
  getEntitlements: vi.fn(async () => ({ voiceMinutesMonth: 1000, readOnly: false })),
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/integrations/redis", () => ({
  redis: {
    set: vi.fn(async (key: string) => {
      if (m.claims.has(key)) return null;
      m.claims.add(key);
      return "OK";
    }),
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
  },
}));

import { POST } from "@/app/api/v1/voice/webhook/route";
import { executeTool } from "@/server/ai/tools";

const searchCall = (id: string) =>
  POST(
    new Request("http://localhost/api/v1/voice/webhook", {
      method: "POST",
      headers: { "x-vapi-signature": "sig" },
      body: JSON.stringify({
        message: {
          type: "tool-calls",
          call: { id: "call-anonymous", assistantId: "va-a" },
          toolCallList: [
            {
              id,
              function: { name: "searchKnowledgeBase", arguments: '{"query":"salary table"}' },
            },
          ],
        },
      }),
    }),
  );

beforeEach(() => {
  m.retrieveChunks.mockClear();
  m.claims.clear();
});

describe("a phone caller and the organization's private documents", () => {
  it("an assistant with the previous defaults reads none of them out", async () => {
    m.assistant = {
      id: "assistant-a",
      organizationId: "org-a",
      enabledTools: ["searchKnowledgeBase"],
      useKnowledgeBase: true,
      isActive: true,
      language: "EN",
      organization: { members: [{ userId: "owner-a" }] },
    };

    const response = await searchCall("tc-1");
    const text = await response.text();

    expect(text).not.toContain("SYNTHETIC-PRIVATE");
    expect(JSON.parse(text).results).toEqual([
      { toolCallId: "tc-1", result: JSON.stringify({ error: "tool_not_enabled" }) },
    ]);
    expect(m.retrieveChunks).not.toHaveBeenCalled();
  });
});

describe("signed-in chat keeps its knowledge base (unchanged)", () => {
  const member = (orgId: string) =>
    ({ orgId, userId: `user-${orgId}`, role: "MEMBER", actorType: "user" }) as const;

  it("a member searches their own organization's documents", async () => {
    const result = JSON.parse(
      await executeTool(member("org-a"), "searchKnowledgeBase", { query: "salary table" }),
    );

    expect(result).toEqual([
      {
        documentId: "doc-private",
        title: "Synthetic payroll (internal)",
        content: "SYNTHETIC-PRIVATE salary table",
      },
    ]);
    expect(m.retrieveChunks).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a" }));
  });

  it("a member of another organization searches only that organization", async () => {
    const result = JSON.parse(
      await executeTool(member("org-b"), "searchKnowledgeBase", { query: "salary table" }),
    );

    expect(result).toEqual([]);
    expect(m.retrieveChunks).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-b" }));
  });
});
