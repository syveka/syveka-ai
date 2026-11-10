import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * The real deleteDocument over the real tenantDb extension and a stateful fake
 * Prisma that applies the nested chunks.deleteMany the way Prisma does: only to
 * the updated document's chunks.
 */
const s = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Args = { where: Row; data?: Row & { chunks?: { deleteMany?: Row } } };
  const state = { documents: [] as Row[], chunks: [] as Row[] };
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const update = vi.fn(async ({ where, data }: Args) => {
    const row = state.documents.find((candidate) => matches(candidate, where));
    if (!row) throw Object.assign(new Error("No record found"), { code: "P2025" });
    const { chunks, ...scalars } = data ?? {};
    if (chunks?.deleteMany) {
      state.chunks = state.chunks.filter((chunk) => chunk.documentId !== row.id);
    }
    return Object.assign(row, scalars);
  });
  const models: Record<string, Record<string, (args: Args) => Promise<unknown>>> = {
    document: {
      findFirst: async ({ where }) =>
        state.documents.find((candidate) => matches(candidate, where)) ?? null,
      update,
    },
  };
  return {
    state,
    update,
    remove: vi.fn(async () => ({ data: null, error: null })),
    audit: vi.fn(),
    prisma: {
      $extends: (config: {
        query: { $allModels: { $allOperations: (input: unknown) => Promise<unknown> } };
      }) =>
        new Proxy(
          {},
          {
            get: (_target, modelKey) =>
              new Proxy(
                {},
                {
                  get: (_inner, operation) => (args: Args) =>
                    config.query.$allModels.$allOperations({
                      model: String(modelKey).charAt(0).toUpperCase() + String(modelKey).slice(1),
                      operation: String(operation),
                      args,
                      query: (finalArgs: Args) =>
                        models[String(modelKey)]![String(operation)]!(finalArgs),
                    }),
                },
              ),
          },
        ),
    },
  };
});

vi.mock("@/server/db/prisma", () => ({ prisma: s.prisma }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ storage: { from: () => ({ remove: s.remove }) } }),
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: s.audit }));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertStorageWithinPlan: vi.fn(),
  assertWithinLimit: vi.fn(),
  EntitlementError: class EntitlementError extends Error {},
  getEntitlements: vi.fn(),
}));

import { deleteDocument, DocumentNotFoundError } from "@/server/services/documents";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC = "10000000-0000-4000-8000-000000000001";
const OTHER_DOC = "10000000-0000-4000-8000-000000000002";
const FOREIGN_DOC = "10000000-0000-4000-8000-000000000003";

const ctx: TenantContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "user@example.test",
  orgId: ORG_A,
  role: "MANAGER",
  locale: "en",
};
const document = (id: string, organizationId: string, chunkCount: number) => ({
  id,
  organizationId,
  title: `Document ${id}`,
  storagePath: `${organizationId}/${id}/file.pdf`,
  chunkCount,
  deletedAt: null as Date | null,
});
const docRow = (id: string) => s.state.documents.find((row) => row.id === id)!;
const chunkDocumentIds = () => s.state.chunks.map((chunk) => chunk.documentId);

beforeEach(() => {
  vi.clearAllMocks();
  s.state.documents = [
    document(DOC, ORG_A, 2),
    document(OTHER_DOC, ORG_A, 1),
    document(FOREIGN_DOC, ORG_B, 1),
  ];
  s.state.chunks = [
    { id: "chunk-1", documentId: DOC },
    { id: "chunk-2", documentId: DOC },
    { id: "chunk-3", documentId: OTHER_DOC },
    { id: "chunk-4", documentId: FOREIGN_DOC },
  ];
});

describe("deleteDocument", () => {
  it("removes the document's chunks and sets chunkCount to 0", async () => {
    await deleteDocument(ctx, DOC);

    expect(chunkDocumentIds()).toEqual([OTHER_DOC, FOREIGN_DOC]);
    expect(docRow(DOC)).toMatchObject({ chunkCount: 0, deletedAt: expect.any(Date) });
    expect(docRow(OTHER_DOC)).toMatchObject({ chunkCount: 1, deletedAt: null });
  });

  it("asks for the chunk removal on the caller's organization's document", async () => {
    await deleteDocument(ctx, DOC);

    expect(s.update).toHaveBeenCalledWith({
      where: { id: DOC, organizationId: ORG_A },
      data: expect.objectContaining({ chunks: { deleteMany: {} }, chunkCount: 0 }),
    });
  });

  it("removes the stored object and audits the deletion", async () => {
    await deleteDocument(ctx, DOC);

    expect(s.remove).toHaveBeenCalledWith([`${ORG_A}/${DOC}/file.pdf`]);
    expect(s.audit).toHaveBeenCalledWith(ctx, {
      action: "document.delete",
      resourceType: "document",
      resourceId: DOC,
      before: { title: `Document ${DOC}` },
    });
  });

  it("does not call Storage for a document with no stored object", async () => {
    docRow(DOC).storagePath = null;

    await deleteDocument(ctx, DOC);

    expect(chunkDocumentIds()).not.toContain(DOC);
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("treats another organization's document as not found and changes nothing", async () => {
    await expect(deleteDocument(ctx, FOREIGN_DOC)).rejects.toBeInstanceOf(DocumentNotFoundError);

    expect(chunkDocumentIds()).toContain(FOREIGN_DOC);
    expect(docRow(FOREIGN_DOC)).toMatchObject({ chunkCount: 1, deletedAt: null });
    expect(s.update).not.toHaveBeenCalled();
    expect(s.remove).not.toHaveBeenCalled();
    expect(s.audit).not.toHaveBeenCalled();
  });

  it("treats an already deleted document as not found", async () => {
    docRow(DOC).deletedAt = new Date("2026-10-01T00:00:00Z");

    await expect(deleteDocument(ctx, DOC)).rejects.toBeInstanceOf(DocumentNotFoundError);

    expect(chunkDocumentIds()).toContain(DOC);
    expect(s.update).not.toHaveBeenCalled();
  });
});
