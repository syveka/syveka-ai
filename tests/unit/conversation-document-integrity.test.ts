import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationFindFirst: vi.fn(),
  documentFindMany: vi.fn(),
  joinCreateMany: vi.fn(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(),
  unscopedPrisma: {
    conversation: { findFirst: mocks.conversationFindFirst },
    document: { findMany: mocks.documentFindMany },
    conversationDocument: { createMany: mocks.joinCreateMany },
  },
}));
vi.mock("@/server/integrations/anthropic", () => ({ anthropic: {} }));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: vi.fn() }));

import { attachDocumentsToConversation } from "@/server/services/conversations";

const organizationId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";

describe("conversation document tenant integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindFirst.mockResolvedValue({ id: conversationId });
    mocks.documentFindMany.mockResolvedValue([{ id: documentId }]);
    mocks.joinCreateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects a conversation outside the supplied organization", async () => {
    mocks.conversationFindFirst.mockResolvedValue(null);
    await expect(
      attachDocumentsToConversation({ organizationId, conversationId, documentIds: [documentId] }),
    ).rejects.toThrow("invalid_conversation_document");
    expect(mocks.joinCreateMany).not.toHaveBeenCalled();
  });

  it("surfaces a direct composite-FK rejection from the database", async () => {
    mocks.joinCreateMany.mockRejectedValue(
      Object.assign(new Error("Foreign key constraint"), { code: "P2003" }),
    );
    await expect(
      attachDocumentsToConversation({ organizationId, conversationId, documentIds: [documentId] }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
