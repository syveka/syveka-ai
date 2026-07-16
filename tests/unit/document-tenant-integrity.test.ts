import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    collection: { findFirst: vi.fn() },
    document: { create: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    enqueue: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
  };
});

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(),
  unscopedPrisma: { $transaction: mocks.transaction },
}));
vi.mock("@/server/supabase/server", () => ({ createSupabaseAdmin: vi.fn() }));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/server/services/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/services/billing/entitlements", () => ({ assertWithinLimit: vi.fn() }));

import { createDocument } from "@/server/services/documents";

const ctx = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "member@example.test",
  role: "MEMBER" as const,
  locale: "EN" as const,
};
const collectionId = "33333333-3333-4333-8333-333333333333";

describe("document tenant relationship integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.document.create.mockResolvedValue({ id: "doc-1" });
  });

  it("rejects a cross-tenant collection through the application service", async () => {
    mocks.tx.collection.findFirst.mockResolvedValue(null);
    await expect(
      createDocument(ctx, {
        sourceType: "NOTE",
        title: "Tenant test",
        collectionId,
        content: "content",
      }),
    ).rejects.toMatchObject({ code: "invalid_collection" });
    expect(mocks.tx.collection.findFirst).toHaveBeenCalledWith({
      where: { id: collectionId, organizationId: ctx.orgId },
      select: { id: true },
    });
    expect(mocks.tx.document.create).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("creates the document transactionally when collection ownership matches", async () => {
    mocks.tx.collection.findFirst.mockResolvedValue({ id: collectionId });
    await createDocument(ctx, {
      sourceType: "NOTE",
      title: "Tenant test",
      collectionId,
      content: "content",
    });
    expect(mocks.tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: ctx.orgId, collectionId }),
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
