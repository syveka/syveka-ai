import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/generated/prisma/client/client";

/**
 * A chat attachment is persisted as an ordinary organization document (listed
 * in the Knowledge Base, retrieved by org-wide RAG), so the chat file routes
 * must require the same `kb:write` permission as the Knowledge Base routes.
 *
 * Real: requirePermission (guard) and the RBAC matrix. Mocked: the session
 * (role under test), audit, the rate limiter's Upstash client, the documents
 * service (so a denial can be proven to happen before any persistence) and
 * the entitlement error class.
 */
const {
  getTenantContextMock,
  auditMock,
  rateLimitMock,
  createDocumentMock,
  createUploadUrlMock,
  FakeAuthError,
  FakeDocumentIngestionError,
  FakeUrlIngestionError,
  FakeEntitlementError,
} = vi.hoisted(() => ({
  getTenantContextMock: vi.fn(),
  auditMock: vi.fn(),
  rateLimitMock: vi.fn(),
  createDocumentMock: vi.fn(),
  createUploadUrlMock: vi.fn(),
  // Declared here so the hoisted mock factories below never see them in TDZ.
  FakeAuthError: class FakeAuthError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403 = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  },
  FakeDocumentIngestionError: class extends Error {
    code = "ingestion_failed";
  },
  FakeUrlIngestionError: class extends Error {
    code = "url_ingestion_failed";
  },
  FakeEntitlementError: class extends Error {
    code = "limit_reached";
    limit = 10;
  },
}));

vi.mock("@/server/auth/session", () => ({
  AuthError: FakeAuthError,
  getTenantContext: getTenantContextMock,
}));

vi.mock("@/server/services/audit", () => ({ audit: auditMock }));

vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow() {
      return {};
    }
    limit(key: string) {
      return rateLimitMock(key);
    }
  },
}));

vi.mock("@/server/services/documents", () => ({
  toDocumentView: (row: unknown) => row,
  createDocument: createDocumentMock,
  createUploadUrl: createUploadUrlMock,
  listDocuments: vi.fn(),
  DocumentIngestionError: FakeDocumentIngestionError,
  UrlIngestionError: FakeUrlIngestionError,
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: FakeEntitlementError,
}));

import { can } from "@/server/auth/permissions";
// The routes load the guard with a dynamic import. Instantiating it from here
// first binds it to the mocked session above on every platform (a guard first
// loaded through the route's own dynamic import did not see the mock on
// Windows).
import "@/server/auth/guard";
import { POST as aiFilesPost } from "@/app/api/v1/ai/files/route";
import { POST as aiFilesUploadUrlPost } from "@/app/api/v1/ai/files/upload-url/route";
import { POST as kbDocumentsPost } from "@/app/api/v1/kb/documents/route";
import { POST as kbUploadUrlPost } from "@/app/api/v1/kb/documents/upload-url/route";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "33333333-3333-3333-3333-333333333333";
const USER_A = "22222222-2222-2222-2222-222222222222";
const INTENT = "55555555-5555-5555-5555-555555555555";

function sessionAs(role: Role, orgId = ORG_A) {
  getTenantContextMock.mockResolvedValue({
    userId: USER_A,
    email: `${role.toLowerCase()}@example.test`,
    orgId,
    role,
    locale: "en",
  });
}

function jsonRequest(body: unknown): Request {
  return new Request("https://example.test/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const finalizeBody = () => jsonRequest({ title: "report", uploadIntentId: INTENT });
const uploadUrlBody = () =>
  jsonRequest({ fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 1024 });

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
    pending: Promise.resolve(),
  });
  createDocumentMock.mockResolvedValue({ id: "doc-1", title: "report", status: "PENDING" });
  createUploadUrlMock.mockResolvedValue({
    uploadIntentId: INTENT,
    signedUrl: "https://example.test/upload",
    expiresAt: new Date(),
  });
});

const chatRoutes = [
  { name: "POST /api/v1/ai/files", handler: aiFilesPost, body: finalizeBody, ok: 201 },
  {
    name: "POST /api/v1/ai/files/upload-url",
    handler: aiFilesUploadUrlPost,
    body: uploadUrlBody,
    ok: 200,
  },
] as const;

function expectNothingPersisted() {
  expect(createDocumentMock).not.toHaveBeenCalled();
  expect(createUploadUrlMock).not.toHaveBeenCalled();
}

describe("the RBAC matrix this fix relies on", () => {
  it("MEMBER and VIEWER lack kb:write while MEMBER keeps chat:use", () => {
    expect(can("MEMBER", "chat:use")).toBe(true);
    expect(can("MEMBER", "kb:write")).toBe(false);
    expect(can("VIEWER", "chat:use")).toBe(false);
    expect(can("VIEWER", "kb:write")).toBe(false);
    for (const role of ["OWNER", "ADMIN", "MANAGER"] as const) {
      expect(can(role, "chat:use")).toBe(true);
      expect(can(role, "kb:write")).toBe(true);
    }
  });
});

describe.each(chatRoutes)("$name requires chat:use and kb:write", ({ handler, body, ok }) => {
  it.each(["OWNER", "ADMIN", "MANAGER"] as const)(
    "%s (chat:use and kb:write) creates the attachment",
    async (role) => {
      sessionAs(role);
      const response = await handler(body());
      expect(response.status).toBe(ok);
      expect(createDocumentMock.mock.calls.length + createUploadUrlMock.mock.calls.length).toBe(1);
    },
  );

  it("MEMBER (chat:use without kb:write) is refused before anything is persisted", async () => {
    sessionAs("MEMBER");
    const response = await handler(body());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "forbidden" } });
    expectNothingPersisted();
    // Refused by authorization, before the rate limiter even runs.
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("VIEWER (neither permission) is refused before anything is persisted", async () => {
    sessionAs("VIEWER");
    const response = await handler(body());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "forbidden" } });
    expectNothingPersisted();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("an unauthenticated request is refused with 401", async () => {
    getTenantContextMock.mockRejectedValue(new FakeAuthError("Not authenticated", 401));
    const response = await handler(body());
    expect(response.status).toBe(401);
    expectNothingPersisted();
  });

  it("the refusal body names no permission, role or organization", async () => {
    sessionAs("MEMBER");
    const text = await (await handler(body())).text();
    expect(text).toBe(JSON.stringify({ error: { code: "forbidden" } }));
    expect(text).not.toContain("kb:write");
    expect(text).not.toContain(ORG_A);
  });
});

describe("tenant binding of a chat attachment", () => {
  it("the organization comes from the session, never from the request body", async () => {
    sessionAs("OWNER", ORG_B);
    // Both schemas are strict: a client-supplied organization field is invalid input.
    const smuggled = await aiFilesPost(
      jsonRequest({ title: "report", uploadIntentId: INTENT, organizationId: ORG_A }),
    );
    expect(smuggled.status).toBe(400);
    expectNothingPersisted();

    const response = await aiFilesPost(finalizeBody());
    expect(response.status).toBe(201);
    expect(createDocumentMock).toHaveBeenCalledTimes(1);
    const [ctx, input] = createDocumentMock.mock.calls[0]!;
    expect(ctx.orgId).toBe(ORG_B);
    expect(ctx.userId).toBe(USER_A);
    expect(input).toEqual({ sourceType: "UPLOAD", title: "report", uploadIntentId: INTENT });
  });

  it("an upload URL is bound to the session's organization and user", async () => {
    sessionAs("ADMIN", ORG_B);
    const smuggled = await aiFilesUploadUrlPost(
      jsonRequest({
        fileName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        organizationId: ORG_A,
      }),
    );
    expect(smuggled.status).toBe(400);
    expectNothingPersisted();

    const response = await aiFilesUploadUrlPost(uploadUrlBody());
    expect(response.status).toBe(200);
    const [ctx] = createUploadUrlMock.mock.calls[0]!;
    expect(ctx.orgId).toBe(ORG_B);
    expect(ctx.userId).toBe(USER_A);
  });
});

describe("Knowledge Base routes keep their existing kb:write rule", () => {
  const kbRoutes = [
    {
      name: "POST /api/v1/kb/documents",
      handler: kbDocumentsPost,
      body: () => jsonRequest({ sourceType: "NOTE", title: "Note", content: "hello" }),
      ok: 201,
    },
    {
      name: "POST /api/v1/kb/documents/upload-url",
      handler: kbUploadUrlPost,
      body: uploadUrlBody,
      ok: 200,
    },
  ] as const;

  it.each(kbRoutes)(
    "$name allows OWNER and refuses MEMBER and VIEWER",
    async ({ handler, body, ok }) => {
      sessionAs("OWNER");
      expect((await handler(body())).status).toBe(ok);
      for (const role of ["MEMBER", "VIEWER"] as const) {
        vi.clearAllMocks();
        sessionAs(role);
        const response = await handler(body());
        expect(response.status).toBe(403);
        expectNothingPersisted();
      }
    },
  );
});
