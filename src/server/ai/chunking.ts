import "server-only";

const TARGET_CHARS = 3_200; // ≈ 800 tokens
const OVERLAP_CHARS = 480; // 15%
const MIN_CHUNK_CHARS = 200;

export type Chunk = { content: string; index: number; tokenCount: number; heading?: string };

/**
 * Heading-aware chunker (§15.5): splits on markdown/blank-line boundaries,
 * packs sections up to ~800 tokens with 15% overlap between chunks.
 */
export function chunkText(text: string): Chunk[] {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let current = "";
  let currentHeading: string | undefined;

  const flush = () => {
    const content = current.trim();
    if (content.length >= MIN_CHUNK_CHARS || (chunks.length === 0 && content.length > 0)) {
      chunks.push({
        content,
        index: chunks.length,
        tokenCount: Math.ceil(content.length / 4),
        heading: currentHeading,
      });
    }
    current = content.slice(-OVERLAP_CHARS); // overlap tail into next chunk
  };

  for (const block of blocks) {
    const headingMatch = /^#{1,4}\s+(.+)$/m.exec(block);
    if (headingMatch) currentHeading = headingMatch[1]?.slice(0, 120);

    if (current.length + block.length + 2 > TARGET_CHARS && current.length > 0) flush();

    // Oversized single block: hard-split on sentence boundaries
    if (block.length > TARGET_CHARS) {
      const sentences = block.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (current.length + s.length + 1 > TARGET_CHARS && current.length > 0) flush();
        current += (current ? " " : "") + s;
      }
    } else {
      current += (current ? "\n\n" : "") + block;
    }
  }
  if (current.trim().length > 0) flush();

  return chunks;
}
