import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The knowledge-base routes with the real guard, real permission matrix, real
 * documents service and real upload-intent validation. The session supplies the
 * role; the database, Storage, queue, audit, rate limiter and entitlements are
 * fakes.
 */
const m = vi.hoisted(() => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403 = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  class EntitlementError extends Error {
    code = "limit_reached";
    limit = 1;
  }
  const storage = {
    download: vi.fn(),
    remove: vi.fn(),
    createSignedUploadUrl: vi.fn(),
  };
  const sideEffects = {
    intentFindFirst: vi.fn(),
    intentCreate: vi.fn(),
    intentUpdateMany: vi.fn(),
    documentCreate: vi.fn(),
    documentUpdate: vi.fn(),
    transaction: vi.fn(),
    createSupabaseAdmin: vi.fn(() => ({ storage: { from: () => storage } })),
    download: storage.download,
    remove: storage.remove,
    createSignedUploadUrl: storage.createSignedUploadUrl,
    enqueue: vi.fn(),
    rateLimitRefusal: vi.fn(),
  };
  return {
    AuthError,
    EntitlementError,
    getTenantContext: vi.fn(),
    audit: vi.fn(),
    tenantFindFirst: vi.fn(),
    tenantFindMany: vi.fn(),
    aggregate: vi.fn(),
    sideEffects,
  };
});

vi.mock("@/server/auth/session", () => ({
  AuthError: m.AuthError,
  getTenantContext: m.getTenantContext,
}));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    document: {
      findFirst: m.tenantFindFirst,
      findMany: m.tenantFindMany,
      update: m.sideEffects.documentUpdate,
    },
    documentUploadIntent: { delete: vi.fn() },
  }),
  unscopedPrisma: {
    documentUploadIntent: {
      findFirst: m.sideEffects.intentFindFirst,
      aggregate: m.aggregate,
      updateMany: m.sideEffects.intentUpdateMany,
    },
    document: {
      aggregate: m.aggregate,
      update: m.sideEffects.documentUpdate,
    },
    $transaction: m.sideEffects.transaction,
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: m.sideEffects.createSupabaseAdmin,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.sideEffects.enqueue }));
vi.mock("@/server/security/rate-limit", () => ({
  rateLimitRefusal: m.sideEffects.rateLimitRefusal,
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: m.EntitlementError,
  assertStorageWithinPlan: vi.fn(),
  assertWithinLimit: vi.fn(async () => undefined),
  getEntitlements: vi.fn(async () => ({})),
}));

// Loaded up front: the routes import these concurrently on first use, which can
// resolve a mocked module's real implementation in Vitest.
import "@/server/auth/guard";
import "@/server/auth/session";
import "@/server/db/tenant";
import "@/server/security/rate-limit";
import "@/server/services/billing/entitlements";
import "@/server/services/documents";
import { GET as listDocuments, POST as postDocument } from "@/app/api/v1/kb/documents/route";
import { POST as postUploadUrl } from "@/app/api/v1/kb/documents/upload-url/route";
import { DELETE as deleteDocumentRoute } from "@/app/api/v1/kb/documents/[id]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const INTENT = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";

const jsonRequest = (body: unknown) =>
  new Request("https://app.test/api/v1/kb/documents", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const asRole = (role: string) =>
  m.getTenantContext.mockResolvedValue({
    userId: USER,
    email: "user@example.test",
    orgId: ORG,
    role,
    locale: "en",
  });
const uploadIntent = (overrides: Record<string, unknown> = {}) => ({
  id: INTENT,
  organizationId: ORG,
  userId: USER,
  storagePath: `${ORG}/upload/file.txt`,
  expectedMimeType: "text/plain",
  maxSizeBytes: 1024,
  expiresAt: new Date(Date.now() + 60_000),
  usedAt: null,
  ...overrides,
});
const finalizeRequest = () =>
  jsonRequest({ sourceType: "UPLOAD", title: "Price list", uploadIntentId: INTENT });
const storedRow = {
  id: DOC,
  title: "Price list",
  sourceType: "UPLOAD",
  sourceUrl: null,
  status: "PENDING",
  error: null,
  chunkCount: 0,
  sizeBytes: 5,
  mimeType: "text/plain",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  asRole("OWNER");
  m.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0, maxSizeBytes: 0 } });
  m.tenantFindFirst.mockResolvedValue({ id: DOC, title: "Price list", storagePath: null });
  m.tenantFindMany.mockResolvedValue([storedRow]);
  m.sideEffects.rateLimitRefusal.mockResolvedValue(null);
  m.sideEffects.documentUpdate.mockResolvedValue({});
  m.sideEffects.documentCreate.mockResolvedValue(storedRow);
  m.sideEffects.intentCreate.mockResolvedValue({ id: INTENT });
  m.sideEffects.intentUpdateMany.mockResolvedValue({ count: 1 });
  m.sideEffects.intentFindFirst.mockResolvedValue(null);
  m.sideEffects.remove.mockResolvedValue({ data: null, error: null });
  m.sideEffects.createSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.test/upload" },
    error: null,
  });
  m.sideEffects.download.mockResolvedValue({
    data: { type: "text/plain", arrayBuffer: async () => new TextEncoder().encode("hello").buffer },
    error: null,
  });
  m.sideEffects.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: vi.fn(),
      collection: { findFirst: vi.fn() },
      document: { aggregate: m.aggregate, create: m.sideEffects.documentCreate },
      documentUploadIntent: {
        aggregate: m.aggregate,
        create: m.sideEffects.intentCreate,
        updateMany: m.sideEffects.intentUpdateMany,
      },
    }),
  );
});

const expectNoSideEffects = (except: Array<keyof typeof m.sideEffects> = []) => {
  for (const [name, effect] of Object.entries(m.sideEffects)) {
    if (!except.includes(name as keyof typeof m.sideEffects)) {
      expect(effect).not.toHaveBeenCalled();
    }
  }
};

const writeRoutes = [
  {
    name: "POST /api/v1/kb/documents",
    call: () => postDocument(jsonRequest({ sourceType: "NOTE", title: "Note", content: "hello" })),
    allowedStatus: 201,
    effect: "enqueue" as const,
  },
  {
    name: "POST /api/v1/kb/documents/upload-url",
    call: () =>
      postUploadUrl(jsonRequest({ fileName: "a.txt", mimeType: "text/plain", sizeBytes: 100 })),
    allowedStatus: 200,
    effect: "createSignedUploadUrl" as const,
  },
  {
    name: "DELETE /api/v1/kb/documents/{id}",
    call: () =>
      deleteDocumentRoute(new Request("https://app.test/x", { method: "DELETE" }), {
        params: Promise.resolve({ id: DOC }),
      }),
    allowedStatus: 200,
    effect: "documentUpdate" as const,
  },
];

describe.each(writeRoutes)("$name requires kb:write", ({ call, allowedStatus, effect }) => {
  it.each(["MEMBER", "VIEWER"])("%s gets 403 with no side effect", async (role) => {
    asRole(role);

    const response = await call();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden" } });
    expectNoSideEffects();
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, userId: USER }), {
      action: "authz.denied",
      resourceType: "permission",
      resourceId: "kb:write",
    });
  });

  it("MANAGER holds the permission and reaches the side effect", async () => {
    asRole("MANAGER");

    const response = await call();

    expect(response.status).toBe(allowedStatus);
    expect(m.sideEffects[effect]).toHaveBeenCalled();
  });
});

describe("GET /api/v1/kb/documents requires kb:read", () => {
  it("VIEWER holds it and receives the list", async () => {
    asRole("VIEWER");

    const response = await listDocuments();

    expect(response.status).toBe(200);
    expect(m.tenantFindMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "Not authenticated"],
    [403, "No organization membership"],
  ] as const)("a session failure with status %i reads nothing", async (status, message) => {
    m.getTenantContext.mockRejectedValue(new m.AuthError(message, status));

    const response = await listDocuments();

    expect(response.status).toBe(status);
    expect(m.tenantFindMany).not.toHaveBeenCalled();
  });
});

describe("finalizing an upload with POST /api/v1/kb/documents", () => {
  it("an expired intent is 410 and nothing is read from Storage or written", async () => {
    m.sideEffects.intentFindFirst.mockResolvedValue(
      uploadIntent({ expiresAt: new Date(Date.now() - 1_000) }),
    );

    const response = await postDocument(finalizeRequest());

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "expired_upload_intent" } });
    expectNoSideEffects(["intentFindFirst", "rateLimitRefusal"]);
  });

  it("an already used intent is 409 and nothing is read from Storage or written", async () => {
    m.sideEffects.intentFindFirst.mockResolvedValue(uploadIntent({ usedAt: new Date() }));

    const response = await postDocument(finalizeRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "reused_upload_intent" } });
    expectNoSideEffects(["intentFindFirst", "rateLimitRefusal"]);
  });

  it("an intent spent by a concurrent request is 409 and creates no document", async () => {
    m.sideEffects.intentFindFirst.mockResolvedValue(uploadIntent());
    m.sideEffects.intentUpdateMany.mockResolvedValue({ count: 0 });

    const response = await postDocument(finalizeRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "reused_upload_intent" } });
    expect(m.sideEffects.documentCreate).not.toHaveBeenCalled();
    expect(m.sideEffects.enqueue).not.toHaveBeenCalled();
  });

  it("looks the intent up by organization and user, so another user's intent is invalid", async () => {
    m.sideEffects.intentFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; organizationId: string; userId: string } }) => {
        const row = uploadIntent({ userId: OTHER_USER });
        return where.id === row.id &&
          where.organizationId === row.organizationId &&
          where.userId === row.userId
          ? row
          : null;
      },
    );

    const response = await postDocument(finalizeRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_upload_intent" } });
    expect(m.sideEffects.intentFindFirst).toHaveBeenCalledWith({
      where: { id: INTENT, organizationId: ORG, userId: USER },
    });
    expectNoSideEffects(["intentFindFirst", "rateLimitRefusal"]);
  });

  it("a fresh intent is consumed conditionally and becomes a queued document", async () => {
    m.sideEffects.intentFindFirst.mockResolvedValue(uploadIntent());

    const response = await postDocument(finalizeRequest());

    expect(response.status).toBe(201);
    expect(m.sideEffects.intentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: INTENT,
        organizationId: ORG,
        userId: USER,
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });
    expect(m.sideEffects.documentCreate).toHaveBeenCalledTimes(1);
    expect(m.sideEffects.enqueue).toHaveBeenCalledWith("embed-document", {
      documentId: DOC,
      orgId: ORG,
    });
  });
});
