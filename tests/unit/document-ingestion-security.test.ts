import { describe, expect, it } from "vitest";
import {
  assertTenantStoragePath,
  validateUploadIntent,
  verifyUploadObject,
} from "@/server/security/document-ingestion";

const now = new Date("2026-07-14T12:00:00.000Z");

function intent(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-a",
    userId: "user-a",
    storagePath: "org-a/upload/file.pdf",
    expectedMimeType: "application/pdf",
    maxSizeBytes: 1_024,
    expiresAt: new Date(now.getTime() + 60_000),
    usedAt: null,
    ...overrides,
  };
}

describe("secure document upload ingestion", () => {
  it("rejects a cross-tenant storage path", () => {
    expect(() => assertTenantStoragePath("org-a", "org-b/upload/file.pdf")).toThrowError(
      expect.objectContaining({ code: "cross_tenant_path" }),
    );
    expect(() =>
      validateUploadIntent(
        intent({ storagePath: "org-b/upload/file.pdf" }),
        { organizationId: "org-a", userId: "user-a" },
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: "cross_tenant_path" }));
  });

  it("rejects an expired upload intent", () => {
    expect(() =>
      validateUploadIntent(
        intent({ expiresAt: new Date(now.getTime() - 1) }),
        { organizationId: "org-a", userId: "user-a" },
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: "expired_upload_intent" }));
  });

  it("rejects a reused upload intent", () => {
    expect(() =>
      validateUploadIntent(
        intent({ usedAt: new Date(now.getTime() - 1_000) }),
        { organizationId: "org-a", userId: "user-a" },
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: "reused_upload_intent" }));
  });

  it("rejects MIME spoofing based on the content signature", () => {
    expect(() =>
      verifyUploadObject(
        Buffer.from("This is plain text, not a PDF"),
        "application/pdf",
        "application/pdf",
        1_024,
      ),
    ).toThrowError(expect.objectContaining({ code: "mime_spoofing" }));
  });

  it("rejects an upload larger than the intent maximum", () => {
    expect(() =>
      verifyUploadObject(Buffer.from("%PDF-1.7\nbody"), "application/pdf", "application/pdf", 5),
    ).toThrowError(expect.objectContaining({ code: "oversized_upload" }));
  });
});
