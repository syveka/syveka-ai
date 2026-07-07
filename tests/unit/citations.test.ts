import { describe, expect, it } from "vitest";
import { extractValidCitations } from "@/server/ai/rag";

const retrieved = [
  {
    chunkId: "c1",
    documentId: "11111111-1111-4111-8111-111111111111",
    content: "x",
    title: "Hinnasto",
    similarity: 0.8,
  },
];

describe("citation validation (§15.6)", () => {
  it("accepts citations for retrieved docs only", () => {
    const answer =
      "Hinta on 100 € [doc:11111111-1111-4111-8111-111111111111]. " +
      "Keksitty [doc:22222222-2222-4222-8222-222222222222].";
    const citations = extractValidCitations(answer, retrieved);
    expect(citations).toEqual([
      { documentId: "11111111-1111-4111-8111-111111111111", title: "Hinnasto" },
    ]);
  });

  it("dedupes repeated citations", () => {
    const answer =
      "[doc:11111111-1111-4111-8111-111111111111] ja [doc:11111111-1111-4111-8111-111111111111]";
    expect(extractValidCitations(answer, retrieved)).toHaveLength(1);
  });

  it("returns empty when the model fabricates everything", () => {
    expect(
      extractValidCitations("[doc:33333333-3333-4333-8333-333333333333]", retrieved),
    ).toEqual([]);
  });
});
