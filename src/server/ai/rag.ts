import "server-only";

import { Prisma } from "@prisma/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { embedOne } from "@/server/integrations/openai";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  content: string;
  title: string;
  similarity: number;
};

/**
 * Org-filtered ANN retrieval via the match_chunks RPC (§15.5).
 * Retrieved text is DATA: instruction-like patterns are neutralized before
 * prompt injection into the model context (§15.6).
 */
export async function retrieveChunks(params: {
  orgId: string;
  query: string;
  count?: number;
  threshold?: number;
}): Promise<RetrievedChunk[]> {
  const embedding = await embedOne(params.query);
  const vector = `[${embedding.join(",")}]`;

  const rows = await unscopedPrisma.$queryRaw<
    Array<{ chunk_id: string; document_id: string; content: string; similarity: number }>
  >(Prisma.sql`
    select chunk_id, document_id, content, similarity
    from match_chunks(
      ${params.orgId}::uuid,
      ${vector}::vector(1536),
      ${params.count ?? 8},
      ${params.threshold ?? 0.35}
    )
  `);

  if (rows.length === 0) return [];

  const docs = await unscopedPrisma.document.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.document_id))] }, organizationId: params.orgId },
    select: { id: true, title: true },
  });
  const titleById = new Map(docs.map((d) => [d.id, d.title]));

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    content: sanitizeChunk(r.content),
    title: titleById.get(r.document_id) ?? "Document",
    similarity: r.similarity,
  }));
}

/** Neutralize instruction-like patterns in retrieved text (§15.6). */
function sanitizeChunk(text: string): string {
  return text
    .replace(/```/g, "ʼʼʼ")
    .replace(/<\/?(system|assistant|instructions?)>/gi, "[tag]")
    .slice(0, 4_000);
}

/** Validate model citations against actually-retrieved docs (§15.6). */
export function extractValidCitations(
  answer: string,
  retrieved: RetrievedChunk[],
): Array<{ documentId: string; title: string }> {
  const cited = [...answer.matchAll(/\[doc:([0-9a-f-]{36})\]/gi)].map((m) => m[1]!);
  const validDocs = new Map(retrieved.map((c) => [c.documentId, c.title]));
  const seen = new Set<string>();
  const result: Array<{ documentId: string; title: string }> = [];
  for (const id of cited) {
    if (validDocs.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push({ documentId: id, title: validDocs.get(id)! });
    }
  }
  return result;
}
