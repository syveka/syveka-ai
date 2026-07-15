import { describe, expect, it } from "vitest";
import { chatFileFinalizeSchema, chatRequestSchema } from "@/lib/validators/chat";
import { uploadUrlSchema } from "@/lib/validators/documents";

describe("AI chat request schemas", () => {
  it("applies safe defaults and accepts conversation document context", () => {
    const parsed = chatRequestSchema.parse({
      message: "Summarize the attachment",
      documentIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(parsed).toMatchObject({ useKnowledgeBase: true, deepMode: false });
  });

  it("rejects unknown fields, oversized prompts and too many attachments", () => {
    expect(chatRequestSchema.safeParse({ message: "x", unexpected: true }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: "x".repeat(8_001) }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        message: "x",
        documentIds: Array.from({ length: 11 }, () => "11111111-1111-4111-8111-111111111111"),
      }).success,
    ).toBe(false);
  });

  it("validates chat upload intent and MIME contracts strictly", () => {
    expect(
      chatFileFinalizeSchema.safeParse({
        title: "Quarterly report",
        uploadIntentId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    expect(
      uploadUrlSchema.safeParse({
        fileName: "malware.exe",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
      }).success,
    ).toBe(false);
  });
});
