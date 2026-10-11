import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    collection: { findFirst: vi.fn() },
    document: { create: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    enqueue: vi.fn(async (..._args: unknown[]) => undefined),
    documentUpdate: vi.fn(async (..._args: unknown[]) => ({})),
    audit: vi.fn(async () => undefined),
  };
});

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(),
  unscopedPrisma: { $transaction: mocks.transaction, document: { update: mocks.documentUpdate } },
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

/**
 * The document row is committed as PENDING before its processing job is queued. If
 * queueing fails, no job will ever run: the document must not sit "Pending" forever
 * (and an upload's single-use intent is already spent, so it can't simply be resent).
 */
describe("document processing that can't be queued", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.collection.findFirst.mockResolvedValue({ id: collectionId });
    mocks.tx.document.create.mockResolvedValue({ id: "doc-1" });
  });

  it("marks the document FAILED with a generic reason and still fails the request", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("QStash 503 at https://qstash.upstash.io"));

    await expect(
      createDocument(ctx, { sourceType: "NOTE", title: "Note", collectionId, content: "content" }),
    ).rejects.toThrow("QStash 503");

    expect(mocks.documentUpdate).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: { status: "FAILED", error: "Processing could not be started. Please try again." },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("a queued document is left PENDING for its job", async () => {
    await createDocument(ctx, { sourceType: "NOTE", title: "Note", collectionId, content: "x" });

    expect(mocks.documentUpdate).not.toHaveBeenCalled();
  });
});
