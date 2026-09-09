import "server-only";

import { DocumentIngestionError } from "./document-ingestion";

export type CreatorAssetMimeType = "image/jpeg" | "image/png" | "image/webp";

export const REFERENCE_ASSET_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1_000;

function hasPrefix(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

function signatureMatches(buffer: Buffer, mimeType: CreatorAssetMimeType): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return hasPrefix(buffer, [0xff, 0xd8, 0xff]);
    case "image/png":
      return hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return (
        hasPrefix(buffer, [0x52, 0x49, 0x46, 0x46]) &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}

/**
 * Magic-byte verification for creator reference image uploads. Reuses
 * DocumentIngestionError's fixed code union (mime_spoofing/oversized_upload/
 * empty_upload already cover what image uploads need) and
 * validateUploadIntent/assertTenantStoragePath from document-ingestion.ts
 * (both are already MIME-agnostic) — only the signature check itself is
 * image-specific, since documents' signatureMatches() is a closed switch
 * over document MIME types.
 */
export function verifyReferenceImageObject(
  buffer: Buffer,
  actualMimeType: string,
  expectedMimeType: CreatorAssetMimeType,
  maximumBytes: number,
): void {
  if (buffer.length === 0) {
    throw new DocumentIngestionError("empty_upload", "Uploaded object is empty");
  }
  if (buffer.length > maximumBytes) {
    throw new DocumentIngestionError(
      "oversized_upload",
      "Uploaded object exceeds its intent limit",
    );
  }

  const normalizedActual = actualMimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedActual !== expectedMimeType || !signatureMatches(buffer, expectedMimeType)) {
    throw new DocumentIngestionError(
      "mime_spoofing",
      "Uploaded object does not match its expected MIME type",
    );
  }
}
