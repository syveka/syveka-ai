import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { verifyJobRequest } from "@/server/jobs/verify";
import { unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { extractText, extractFromUrl } from "@/server/ai/extract";
import { chunkText } from "@/server/ai/chunking";
import { embed } from "@/server/integrations/openai";
import { recordUsage } from "@/server/services/billing/entitlements";

export const runtime = "nodejs";
export const maxDuration = 300;

const payloadSchema = z.object({
  documentId: z.string().uuid(),
  orgId: z.string().uuid(),
  inlineContent: z.string().optional(),
});

const EMBED_BATCH = 64;

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const parsed = payloadSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { documentId, orgId, inlineContent } = parsed.data;

  const document = await unscopedPrisma.document.findFirst({
    where: { id: documentId, organizationId: orgId, deletedAt: null },
  });
  if (!document) return NextResponse.json({ skipped: "document gone" });

  await unscopedPrisma.document.update({
    where: { id: documentId },
    data: { status: "PROCESSING", error: null },
  });

  try {
    // 1. Extract
    let text: string;
    if (inlineContent !== undefined) {
      text = inlineContent;
    } else if (document.sourceType === "URL" && document.sourceUrl) {
      text = await extractFromUrl(document.sourceUrl);
    } else if (document.storagePath) {
      const admin = createSupabaseAdmin();
      const { data, error } = await admin.storage.from("documents").download(document.storagePath);
      if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
      text = await extractText(Buffer.from(await data.arrayBuffer()), document.mimeType ?? "text/plain");
    } else {
      throw new Error("No content source");
    }

    // 2. Chunk
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("Document produced no extractable text");

    // 3. Embed in batches + insert (replace any previous chunks: reprocess-safe)
    await unscopedPrisma.documentChunk.deleteMany({ where: { documentId } });

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embeddings = await embed(batch.map((c) => c.content));

      await unscopedPrisma.$transaction(
        batch.map((chunk, j) =>
          unscopedPrisma.$executeRaw(Prisma.sql`
            insert into document_chunks
              (id, document_id, organization_id, chunk_index, content, token_count, embedding, metadata)
            values (
              gen_random_uuid(), ${documentId}::uuid, ${orgId}::uuid, ${chunk.index},
              ${chunk.content}, ${chunk.tokenCount},
              ${`[${embeddings[j]!.join(",")}]`}::vector(1536),
              ${JSON.stringify({ heading: chunk.heading ?? null })}::jsonb
            )
          `),
        ),
      );
    }

    await unscopedPrisma.document.update({
      where: { id: documentId },
      data: { status: "READY", chunkCount: chunks.length },
    });
    await recordUsage(orgId, "EMBEDDINGS", chunks.length, { documentId });

    // Notify uploader (in-app; Realtime picks it up from the table insert)
    await unscopedPrisma.notification.create({
      data: {
        organizationId: orgId,
        userId: document.uploadedById,
        type: "document.ready",
        title: document.title,
        href: "/knowledge",
      },
    });

    return NextResponse.json({ ok: true, chunks: chunks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "processing failed";
    await unscopedPrisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED", error: message },
    });
    await unscopedPrisma.notification.create({
      data: {
        organizationId: orgId,
        userId: document.uploadedById,
        type: "document.failed",
        title: document.title,
        body: message,
        href: "/knowledge",
      },
    });
    // 200: extraction failures are terminal, don't burn QStash retries
    return NextResponse.json({ ok: false, error: message });
  }
}
