import "server-only";

import type { ALLOWED_MIME_TYPES } from "@/lib/validators/documents";

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const UPLOAD_INTENT_TTL_MS = 10 * 60 * 1_000;
export const MAX_EXTRACTED_CHARS = 2_000_000;
export const MAX_DOCUMENT_CHUNKS = 1_000;

export type UploadIntentRecord = {
  organizationId: string;
  userId: string;
  storagePath: string;
  expectedMimeType: string;
  maxSizeBytes: number;
  expiresAt: Date;
  usedAt: Date | null;
};

export class DocumentIngestionError extends Error {
  constructor(
    public readonly code:
      | "cross_tenant_path"
      | "expired_upload_intent"
      | "reused_upload_intent"
      | "invalid_upload_intent"
      | "mime_spoofing"
      | "oversized_upload"
      | "empty_upload",
    message: string,
  ) {
    super(message);
    this.name = "DocumentIngestionError";
  }
}

export function assertTenantStoragePath(organizationId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${organizationId}/`)) {
    throw new DocumentIngestionError(
      "cross_tenant_path",
      "Upload object path is outside the active organization",
    );
  }
}

export function validateUploadIntent(
  intent: UploadIntentRecord,
  context: { organizationId: string; userId: string },
  now = new Date(),
): void {
  if (intent.organizationId !== context.organizationId || intent.userId !== context.userId) {
    throw new DocumentIngestionError("invalid_upload_intent", "Upload intent is not valid");
  }
  assertTenantStoragePath(context.organizationId, intent.storagePath);
  if (intent.usedAt) {
    throw new DocumentIngestionError("reused_upload_intent", "Upload intent was already used");
  }
  if (intent.expiresAt.getTime() <= now.getTime()) {
    throw new DocumentIngestionError("expired_upload_intent", "Upload intent has expired");
  }
}

function hasPrefix(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

function isValidUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function signatureMatches(buffer: Buffer, mimeType: AllowedMimeType): boolean {
  switch (mimeType) {
    case "application/pdf":
      return buffer.subarray(0, 1_024).includes(Buffer.from("%PDF-"));
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const isZip =
        hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
        hasPrefix(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
        hasPrefix(buffer, [0x50, 0x4b, 0x07, 0x08]);
      return (
        isZip &&
        buffer.includes(Buffer.from("[Content_Types].xml")) &&
        buffer.includes(Buffer.from("word/"))
      );
    }
    case "text/html": {
      if (!isValidUtf8Text(buffer)) return false;
      const start = buffer.toString("utf8", 0, Math.min(buffer.length, 4_096)).trimStart();
      return /^(?:<!doctype\s+html|<html|<(?:head|body|title|main|article|section)[\s>])/i.test(
        start,
      );
    }
    case "text/plain":
    case "text/markdown":
      return (
        isValidUtf8Text(buffer) &&
        !hasPrefix(buffer, [0x50, 0x4b]) &&
        !buffer.subarray(0, 1_024).includes(Buffer.from("%PDF-"))
      );
  }
}

export function verifyUploadObject(
  buffer: Buffer,
  actualMimeType: string,
  expectedMimeType: AllowedMimeType,
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

export function assertExtractionLimits(text: string, chunkCount?: number): void {
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new Error(`Extracted content exceeds ${MAX_EXTRACTED_CHARS} characters`);
  }
  if (chunkCount !== undefined && chunkCount > MAX_DOCUMENT_CHUNKS) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_CHUNKS} chunks`);
  }
}
