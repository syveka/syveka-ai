import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The conversation page restores saved write actions with their recorded
 * outcome and passes them to ChatView. Real: the page and the restore
 * functions. Mocked: auth, conversation service, audit table, ChatView
 * (captures its props).
 */
const m = vi.hoisted(() => ({
  props: null as null | { initialMessages: Array<{ id: string; actions?: unknown[] }> },
  auditRows: [] as Array<Record<string, unknown>>,
  messages: [] as unknown[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1", role: "MEMBER" })),
}));
vi.mock("@/server/services/conversations", () => ({
  listConversations: vi.fn(async () => []),
  getConversationWithMessages: vi.fn(async () => ({ id: "conv-1", messages: m.messages })),
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    auditLog: {
      findMany: vi.fn(
        async ({ where }: { where: { organizationId: string; resourceId: { in: string[] } } }) =>
          m.auditRows.filter(
            (r) =>
              r.organizationId === where.organizationId &&
              where.resourceId.in.includes(String(r.resourceId)),
          ),
      ),
    },
  },
}));
vi.mock("@/components/chat/conversation-list", () => ({ ConversationList: () => null }));
vi.mock("@/components/chat/chat-view", () => ({
  ChatView: (props: never) => {
    m.props = props;
    return null;
  },
}));
vi.mock("@/server/ai/transcription-pilot", () => ({ isTranscriptionPilotMember: () => false }));
vi.mock("@/server/ai/voice-conversation-page", () => ({ liveVoiceFor: () => null }));

import ConversationPage from "@/app/[locale]/(app)/chat/[conversationId]/page";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const action = (n: number, expiresAt = Date.now() + 600_000) => ({
  id: id(n),
  tool: "createContact",
  digest: "a".repeat(64),
  conversationId: "conv-1",
  expiresAt,
  details: { tool: "createContact", firstName: `QA ${n}` },
});
const assistant = (mid: string, toolCalls: unknown) => ({
  id: mid,
  role: "ASSISTANT",
  content: "When you confirm, I'll create the contact.",
  citations: null,
  toolCalls,
});

beforeEach(() => {
  m.props = null;
  m.auditRows = [];
});

async function open() {
  const el = await ConversationPage({ params: Promise.resolve({ conversationId: "conv-1" }) });
  // Render the returned tree just enough to call ChatView with its props.
  const children = (el as { props: { children: unknown[] } }).props.children;
  const view = (
    children[1] as { props: { children: { type: (p: unknown) => unknown; props: unknown } } }
  ).props.children;
  view.type(view.props);
  return m.props!.initialMessages;
}

describe("conversation page: saved actions come back with their recorded outcome", () => {
  it("done, canceled, failed, expired-unrecorded and pending; legacy messages have none", async () => {
    m.messages = [
      { id: "u1", role: "USER", content: "Create a contact", citations: null, toolCalls: null },
      assistant("a1", [{ name: "createContact", ok: true, action: action(1) }]),
      assistant("a2", [{ name: "createContact", ok: true, action: action(2) }]),
      assistant("a3", [{ name: "createContact", ok: true, action: action(3) }]),
      assistant("a4", [{ name: "createContact", ok: true, action: action(4, Date.now() - 1) }]),
      assistant("a5", [{ name: "createContact", ok: true, action: action(5) }]),
      assistant("legacy", [{ name: "createContact", ok: true }]),
    ];
    m.auditRows = [
      {
        organizationId: "org-a",
        resourceType: "ai_action",
        resourceId: id(1),
        action: "ai_action.confirm",
        after: { outcome: "done" },
      },
      {
        organizationId: "org-a",
        resourceType: "ai_action",
        resourceId: id(2),
        action: "ai_action.cancel",
        after: { outcome: "canceled" },
      },
      {
        organizationId: "org-a",
        resourceType: "ai_action",
        resourceId: id(3),
        action: "ai_action.confirm",
        after: { outcome: "failed" },
      },
      // Another organization's record for action 5 is never used.
      {
        organizationId: "org-b",
        resourceType: "ai_action",
        resourceId: id(5),
        action: "ai_action.confirm",
        after: { outcome: "done" },
      },
    ];
    const messages = await open();
    const state = (mid: string) =>
      (
        messages.find((x) => x.id === mid)?.actions as Array<{ restored?: string }> | undefined
      )?.map((a) => a.restored ?? "pending");
    expect(state("a1")).toEqual(["done"]);
    expect(state("a2")).toEqual(["canceled"]);
    expect(state("a3")).toEqual(["failed"]);
    expect(state("a4")).toEqual(["unavailable"]);
    expect(state("a5")).toEqual(["pending"]);
    expect(state("legacy")).toBeUndefined();
    expect(state("u1")).toBeUndefined();
  });
});
