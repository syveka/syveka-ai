import { z } from "zod";

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/html",
] as const;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // §13.2

const documentBase = {
  title: z.string().min(1).max(200),
  collectionId: z.string().uuid().optional(),
};

export const createDocumentSchema = z.discriminatedUnion("sourceType", [
  z.object({
    ...documentBase,
    sourceType: z.literal("UPLOAD"),
    uploadIntentId: z.string().uuid(),
  }),
  z.object({
    ...documentBase,
    sourceType: z.literal("URL"),
    sourceUrl: z.string().url().max(2_048),
  }),
  z.object({
    ...documentBase,
    sourceType: z.literal("NOTE"),
    content: z.string().max(100_000),
  }),
]);

export const uploadUrlSchema = z
  .object({
    fileName: z.string().min(1).max(200),
    mimeType: z.enum(ALLOWED_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  })
  .strict();

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
