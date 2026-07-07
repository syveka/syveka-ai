import { describe, expect, it } from "vitest";
import { chunkText } from "@/server/ai/chunking";

describe("RAG chunker (§15.5)", () => {
  it("returns empty for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short document as one chunk", () => {
    const chunks = chunkText("# Hinnasto\n\nPerushinta on 100 euroa kuukaudessa.".repeat(1));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.index).toBe(0);
  });

  it("splits long documents and preserves order", () => {
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
    const doc = Array.from({ length: 10 }, (_, i) => `## Section ${i}\n\n${para}`).join("\n\n");
    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(4200);
  });

  it("tracks headings for citation metadata", () => {
    const doc = `# Toimitusehdot\n\n${"Toimitus kestää 3-5 päivää. ".repeat(50)}`;
    const chunks = chunkText(doc);
    expect(chunks[0]!.heading).toBe("Toimitusehdot");
  });

  it("hard-splits oversized single blocks on sentences", () => {
    const oneBlock = "Tämä on virke. ".repeat(600); // >> TARGET_CHARS, no blank lines
    const chunks = chunkText(oneBlock);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
