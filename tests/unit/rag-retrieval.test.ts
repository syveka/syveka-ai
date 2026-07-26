import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryRow = { chunk_id: string; document_id: string; content: string; similarity: number };
type DocRow = { id: string; title: string };

const { unscopedMock, embedOneMock } = vi.hoisted(() => ({
  unscopedMock: {
    $queryRaw: vi.fn(async (_query: { sql: string }) => [] as QueryRow[]),
    document: { findMany: vi.fn(async (_args: unknown) => [] as DocRow[]) },
  },
  embedOneMock: vi.fn(async () => new Array(1536).fill(0.01)),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
}));
vi.mock("@/server/integrations/openai", () => ({
  embedOne: embedOneMock,
}));

import { retrieveChunks } from "@/server/ai/rag";

beforeEach(() => {
  vi.clearAllMocks();
  unscopedMock.$queryRaw.mockResolvedValue([]);
  unscopedMock.document.findMany.mockResolvedValue([]);
});

describe("retrieveChunks", () => {
  it("general search (no documentIds) delegates eligibility filtering to match_chunks()", async () => {
    await retrieveChunks({ orgId: "org-a", query: "hello" });
    expect(unscopedMock.$queryRaw).toHaveBeenCalledTimes(1);
    const query = unscopedMock.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain("match_chunks(");
    // The general path must not re-implement its own deleted_at/status filter — that
    // eligibility check now lives entirely inside match_chunks() (see the
    // 20260727000000_fix_match_chunks_document_eligibility migration), so a pre-limit
    // application-layer filter here would just be dead code, not a real guard.
    expect(query.sql).not.toContain("deleted_at");
    expect(query.sql).not.toContain("status");
  });

  it("documentId-scoped search still filters deleted_at/status itself, unchanged", async () => {
    await retrieveChunks({ orgId: "org-a", query: "hello", documentIds: ["doc-1", "doc-2"] });
    expect(unscopedMock.$queryRaw).toHaveBeenCalledTimes(1);
    const query = unscopedMock.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain("d.deleted_at is null");
    expect(query.sql).toContain("d.status = 'READY'");
    expect(query.sql).toContain("dc.organization_id =");
    expect(query.sql).toContain("dc.document_id in");
    expect(query.sql).not.toContain("match_chunks(");
  });

  it("maps returned rows to titles and sanitizes content", async () => {
    unscopedMock.$queryRaw.mockResolvedValue([
      { chunk_id: "chunk-1", document_id: "doc-1", content: "```danger``` text", similarity: 0.9 },
    ]);
    unscopedMock.document.findMany.mockResolvedValue([{ id: "doc-1", title: "My Doc" }]);
    const result = await retrieveChunks({ orgId: "org-a", query: "hello" });
    expect(result).toEqual([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        content: "ʼʼʼdangerʼʼʼ text",
        title: "My Doc",
        similarity: 0.9,
      },
    ]);
  });

  it("returns an empty array when no chunks match", async () => {
    const result = await retrieveChunks({ orgId: "org-a", query: "hello" });
    expect(result).toEqual([]);
    expect(unscopedMock.document.findMany).not.toHaveBeenCalled();
  });
});
