import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET/DELETE /api/v1/kb/documents/{id}: a document is shown in the same
 * shape as the list (never its storage object path), and an unknown,
 * deleted or other organization's id is a 404 on both methods, never a 500.
 * Mocked: the permission guard, the tenant-scoped database, Storage, audit
 * and the job queue.
 */
const m = vi.hoisted(() => ({
  ctx: { orgId: "11111111-1111-4111-8111-111111111111", userId: "u-1", role: "MEMBER" },
  rows: [] as Array<Record<string, unknown>>,
  findFirst: vi.fn(),
  update: vi.fn(async () => ({})),
  remove: vi.fn(async () => ({ data: null, error: null })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/auth/guard", () => ({ requirePermission: vi.fn(async () => m.ctx) }));
vi.mock("@/server/auth/session", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: (orgId: string) => ({
    document: {
      findFirst: m.findFirst.mockImplementation(
        async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, true>;
        }) => {
          const row = m.rows.find(
            (r) =>
              r.id === where.id &&
              r.organizationId === orgId &&
              (where.deletedAt !== null || !r.deletedAt),
          );
          if (!row) return null;
          return select
            ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]))
            : row;
        },
      ),
      update: m.update,
    },
  }),
  unscopedPrisma: {},
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ storage: { from: () => ({ remove: m.remove }) } }),
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
vi.mock("@/server/services/billing/entitlements", () => ({ assertWithinLimit: vi.fn() }));

import { DELETE, GET } from "@/app/api/v1/kb/documents/[id]/route";

const DOC = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string) =>
  new Request(`https://app.test/api/v1/kb/documents/${DOC}`, { method });

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [
    {
      id: DOC,
      organizationId: m.ctx.orgId,
      title: "Price list",
      sourceType: "UPLOAD",
      sourceUrl: null,
      status: "FAILED",
      error: "Processing failed. Please try again.",
      chunkCount: 0,
      sizeBytes: 1234,
      mimeType: "application/pdf",
      storagePath: `${m.ctx.orgId}/documents/secret-object-name.pdf`,
      uploadedById: "u-1",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      deletedAt: null,
    },
    { id: "other", organizationId: OTHER_ORG, title: "Theirs", deletedAt: null },
  ];
});

describe("GET /api/v1/kb/documents/{id}", () => {
  it("returns the list shape: never the storage object path, with the stalled flag", async () => {
    const res = await GET(req("GET"), params(DOC));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: DOC,
      title: "Price list",
      status: "FAILED",
      error: "Processing failed. Please try again.",
      stalled: false,
    });
    expect(body.data).not.toHaveProperty("storagePath");
    expect(body.data).not.toHaveProperty("uploadedById");
    expect(JSON.stringify(body)).not.toContain("secret-object-name");
  });

  it.each([
    ["an unknown id", "44444444-4444-4444-8444-444444444444"],
    ["another organization's id", "other"],
  ])("%s is 404", async (_name, id) => {
    const res = await GET(req("GET"), params(id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "resource_not_found" } });
  });

  it("a deleted document is 404", async () => {
    m.rows[0]!.deletedAt = new Date();
    expect((await GET(req("GET"), params(DOC))).status).toBe(404);
  });
});

describe("DELETE /api/v1/kb/documents/{id}", () => {
  it("deletes the organization's own document and its storage object, audited", async () => {
    const res = await DELETE(req("DELETE"), params(DOC));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(m.remove).toHaveBeenCalledWith([`${m.ctx.orgId}/documents/secret-object-name.pdf`]);
    expect(m.audit).toHaveBeenCalledWith(
      m.ctx,
      expect.objectContaining({ action: "document.delete", resourceId: DOC }),
    );
  });

  it.each([
    ["an unknown id", "44444444-4444-4444-8444-444444444444"],
    ["another organization's id", "other"],
  ])("%s is 404 and nothing is written or removed", async (_name, id) => {
    const res = await DELETE(req("DELETE"), params(id));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "resource_not_found" } });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("an already deleted document is 404: it is not deleted twice", async () => {
    m.rows[0]!.deletedAt = new Date();
    const res = await DELETE(req("DELETE"), params(DOC));
    expect(res.status).toBe(404);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });
});
