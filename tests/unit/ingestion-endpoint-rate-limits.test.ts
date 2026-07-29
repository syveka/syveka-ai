import { beforeEach, describe, expect, it, vi } from "vitest";

const { requirePermissionMock, rateLimitMock, createDocumentMock, createUploadUrlMock } =
  vi.hoisted(() => ({
    requirePermissionMock: vi.fn(),
    rateLimitMock: vi.fn(),
    createDocumentMock: vi.fn(),
    createUploadUrlMock: vi.fn(),
  }));

class FakeAuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

class FakeDocumentIngestionError extends Error {
  code = "ingestion_failed";
}

class FakeUrlIngestionError extends Error {
  code = "url_ingestion_failed";
}

class FakeEntitlementError extends Error {
  code = "limit_reached";
  limit = 10;
}

vi.mock("@/server/auth/guard", () => ({
  requirePermission: requirePermissionMock,
}));

vi.mock("@/server/auth/session", () => ({
  AuthError: FakeAuthError,
}));

vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { api: { limit: rateLimitMock } },
}));

vi.mock("@/server/services/documents", () => ({
  createDocument: createDocumentMock,
  createUploadUrl: createUploadUrlMock,
  listDocuments: vi.fn(),
  DocumentIngestionError: FakeDocumentIngestionError,
  UrlIngestionError: FakeUrlIngestionError,
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: FakeEntitlementError,
}));

import { POST as kbDocumentsPost } from "@/app/api/v1/kb/documents/route";
import { POST as kbUploadUrlPost } from "@/app/api/v1/kb/documents/upload-url/route";
import { POST as aiFilesPost } from "@/app/api/v1/ai/files/route";
import { POST as aiFilesUploadUrlPost } from "@/app/api/v1/ai/files/upload-url/route";

function jsonRequest(body: unknown): Request {
  return new Request("https://example.test/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "22222222-2222-2222-2222-222222222222";
const ORG_B = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";

function ctxFor(orgId: string, userId: string) {
  return { orgId, userId, role: "OWNER", email: "owner@example.test", locale: "en" };
}

const ALLOWED = {
  success: true,
  limit: 100,
  remaining: 99,
  reset: Date.now() + 60_000,
  pending: Promise.resolve(),
};
const DENIED = {
  success: false,
  limit: 100,
  remaining: 0,
  reset: Date.now() + 60_000,
  pending: Promise.resolve(),
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue(ALLOWED);
  requirePermissionMock.mockResolvedValue(ctxFor(ORG_A, USER_A));
  createDocumentMock.mockResolvedValue({ id: "doc-1", title: "Note", status: "READY" });
  createUploadUrlMock.mockResolvedValue({
    uploadUrl: "https://example.test/upload",
    documentUploadIntentId: "intent-1",
  });
});

const routes = [
  {
    name: "POST /api/v1/kb/documents",
    handler: kbDocumentsPost,
    keyPrefix: "kb-documents",
    body: () => jsonRequest({ sourceType: "NOTE", title: "Note", content: "hello" }),
    expectedSuccessStatus: 201,
  },
  {
    name: "POST /api/v1/kb/documents/upload-url",
    handler: kbUploadUrlPost,
    keyPrefix: "kb-documents-upload-url",
    body: () => jsonRequest({ fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1024 }),
    expectedSuccessStatus: 200,
  },
  {
    name: "POST /api/v1/ai/files",
    handler: aiFilesPost,
    keyPrefix: "ai-files",
    body: () =>
      jsonRequest({ title: "Note", uploadIntentId: "55555555-5555-5555-5555-555555555555" }),
    expectedSuccessStatus: 201,
  },
  {
    name: "POST /api/v1/ai/files/upload-url",
    handler: aiFilesUploadUrlPost,
    keyPrefix: "ai-files-upload-url",
    body: () => jsonRequest({ fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1024 }),
    expectedSuccessStatus: 200,
  },
];

describe.each(routes)(
  "$name rate limiting",
  ({ handler, keyPrefix, body, expectedSuccessStatus }) => {
    it("invokes rateLimiters.api, keyed by org+user, before doing any work", async () => {
      await handler(body());
      expect(rateLimitMock).toHaveBeenCalledTimes(1);
      expect(rateLimitMock).toHaveBeenCalledWith(`${keyPrefix}:${ORG_A}:${USER_A}`);
    });

    it("returns the established 429 response when the limiter denies the request", async () => {
      rateLimitMock.mockResolvedValue(DENIED);
      const response = await handler(body());
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({ error: { code: "rate_limited" } });
      expect(response.headers.get("Retry-After")).toBeTruthy();
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(createDocumentMock).not.toHaveBeenCalled();
      expect(createUploadUrlMock).not.toHaveBeenCalled();
    });

    it("preserves existing success behavior when the request is allowed", async () => {
      const response = await handler(body());
      expect(response.status).toBe(expectedSuccessStatus);
    });

    it("uses distinct keys per organization/user pair -- no cross-tenant collision", async () => {
      requirePermissionMock.mockResolvedValueOnce(ctxFor(ORG_A, USER_A));
      await handler(body());
      requirePermissionMock.mockResolvedValueOnce(ctxFor(ORG_B, USER_B));
      await handler(body());
      const calledKeys = rateLimitMock.mock.calls.map((c) => c[0]);
      expect(calledKeys[0]).toBe(`${keyPrefix}:${ORG_A}:${USER_A}`);
      expect(calledKeys[1]).toBe(`${keyPrefix}:${ORG_B}:${USER_B}`);
      expect(calledKeys[0]).not.toBe(calledKeys[1]);
    });
  },
);

describe("cross-endpoint key isolation", () => {
  it("different endpoints use different key prefixes for the same org/user", async () => {
    for (const route of routes) {
      requirePermissionMock.mockResolvedValueOnce(ctxFor(ORG_A, USER_A));
      await route.handler(route.body());
    }
    const keys = rateLimitMock.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
