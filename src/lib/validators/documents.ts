import { z } from "zod";

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/html",
] as const;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // §13.2

export const createDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  collectionId: z.string().uuid().optional(),
  sourceType: z.enum(["UPLOAD", "URL", "NOTE"]),
  // UPLOAD:
  storagePath: z.string().max(500).optional(),
  mimeType: z.enum(ALLOWED_MIME_TYPES).optional(),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES).optional(),
  // URL:
  sourceUrl: z.string().url().optional(),
  // NOTE:
  content: z.string().max(100_000).optional(),
});

export const uploadUrlSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
