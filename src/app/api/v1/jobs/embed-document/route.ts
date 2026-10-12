import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const payloadSchema = z.object({
  documentId: z.string().uuid(),
  orgId: z.string().uuid(),
  inlineContent: z.string().optional(),
});

const EMBED_BATCH = 64;

const GENERIC_FAILURE = "Processing failed. Please try again.";
const UNREADABLE_DOCUMENT = "The document could not be read.";

/** A failure of this job whose message is written for the document's owner. */
class DocumentProcessingError extends Error {
  override name = "DocumentProcessingError";
}

/**
 * What the owner sees (document.error, rendered as-is, and the failure notification).
 * Only errors this codebase raises with fixed text written for the owner keep their
 * message, matched by class rather than by `name`, which any error can set. The
 * parser's own failure (`parser_failed`) carries the PDF/DOCX library's message, which
 * can include file paths, so it gets a fixed text. Anything else -- a provider, storage
 * or database error -- can carry keys, URLs or query detail (CLAUDE.md §4), so it
 * becomes a generic message and is only logged by class name.
 */
function failureMessage(
  err: unknown,
  ownerFacing: ReadonlyArray<abstract new (...args: never[]) => Error>,
): string {
  if (!(err instanceof Error)) return GENERIC_FAILURE;
  if ("code" in err && err.code === "parser_failed") return UNREADABLE_DOCUMENT;
  if (err instanceof DocumentProcessingError || ownerFacing.some((type) => err instanceof type)) {
    return err.message.slice(0, 500);
  }
  return GENERIC_FAILURE;
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { Prisma },
    { verifyJobRequest },
    { unscopedPrisma },
    { createSupabaseAdmin },
    { extractText, extractFromUrl },
    { chunkText },
    { embed },
    { recordUsage },
    { assertExtractionLimits, assertTenantStoragePath, verifyUploadObject, DocumentIngestionError },
    { isOrganizationActive, ORGANIZATION_INACTIVE },
    { ParserSecurityError },
    { UrlIngestionError },
    { DOCUMENT_PROCESSING_RECLAIM_MS },
  ] = await Promise.all([
    import("@/generated/prisma/client/client"),
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/supabase/server"),
    import("@/server/ai/extract"),
    import("@/server/ai/chunking"),
    import("@/server/integrations/openai"),
    import("@/server/services/billing/entitlements"),
    import("@/server/security/document-ingestion"),
    import("@/server/jobs/organization-guard"),
    import("@/server/security/parser-security"),
    import("@/server/security/url-ingestion"),
    import("@/lib/knowledge/processing"),
  ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const parsed = payloadSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { documentId, orgId, inlineContent } = parsed.data;

  // Nothing is fetched, embedded (a paid call) or stored for a missing or
  // soft-deleted organization; the document's status is left as it is.
  if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);

  const document = await unscopedPrisma.document.findFirst({
    where: { id: documentId, organizationId: orgId, deletedAt: null },
  });
  if (!document) return NextResponse.json({ skipped: "document gone" });

  // Claim the document, so one delivery at a time replaces its chunks and
  // pays for embeddings. QStash can deliver a job again (a retry after a
  // lost response, or at-least-once redelivery) while or after a run works
  // on it; two runs interleaving deleteMany and their inserts would leave
  // duplicate chunks. A PROCESSING claim past the reclaim window belongs to
  // a run the platform already stopped, so it is taken over.
  const claimed = await unscopedPrisma.document.updateMany({
    where: {
      id: documentId,
      organizationId: orgId,
      deletedAt: null,
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        {
          status: "PROCESSING",
          updatedAt: { lt: new Date(Date.now() - DOCUMENT_PROCESSING_RECLAIM_MS) },
        },
      ],
    },
    data: { status: "PROCESSING", error: null, updatedAt: new Date() },
  });
  if (claimed.count === 0) {
    const current = await unscopedPrisma.document.findFirst({
      where: { id: documentId, organizationId: orgId, deletedAt: null },
      select: { status: true },
    });
    if (!current) return NextResponse.json({ skipped: "document gone" });
    // Already searchable: a redelivery of a finished job redoes nothing.
    if (current.status === "READY") return NextResponse.json({ skipped: "already processed" });
    // Another delivery is working on it now. Non-2xx makes QStash retry later,
    // when that run has finished (READY) or is past the reclaim window.
    return NextResponse.json({ error: "processing_in_progress" }, { status: 409 });
  }

  let chunkCount = 0;
  try {
    // 1. Extract
    let text: string;
    if (inlineContent !== undefined) {
      text = inlineContent;
    } else if (document.sourceType === "URL" && document.sourceUrl) {
      text = await extractFromUrl(document.sourceUrl, request.signal);
    } else if (document.storagePath) {
      assertTenantStoragePath(orgId, document.storagePath);
      const admin = createSupabaseAdmin();
      const { data, error } = await admin.storage.from("documents").download(document.storagePath);
      if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
      const buffer = Buffer.from(await data.arrayBuffer());
      const mimeType = document.mimeType ?? "text/plain";
      verifyUploadObject(
        buffer,
        data.type,
        mimeType as Parameters<typeof verifyUploadObject>[2],
        document.sizeBytes ?? 0,
      );
      text = await extractText(buffer, mimeType, request.signal);
    } else {
      throw new Error("No content source");
    }

    // 2. Chunk
    assertExtractionLimits(text);
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new DocumentProcessingError("Document produced no extractable text");
    }
    assertExtractionLimits(text, chunks.length);

    // 3. Embed in batches + insert (replace any previous chunks: reprocess-safe)
    await unscopedPrisma.documentChunk.deleteMany({ where: { documentId } });

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      // Before each paid call, and before storing its result: deletion during
      // the call stops further batches, the result, usage and notification.
      if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);
      const embeddings = await embed(batch.map((c) => c.content));
      if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);

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
    chunkCount = chunks.length;
  } catch (err) {
    // Deleted meanwhile: no failure record or notification (no retry either).
    if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);
    console.error(
      JSON.stringify({
        event: "document_embed_failed",
        orgId,
        documentId,
        name: err instanceof Error ? err.name : "unknown",
      }),
    );
    const message = failureMessage(err, [
      DocumentIngestionError,
      ParserSecurityError,
      UrlIngestionError,
    ]);
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

  // The document is READY: its chunks are stored and searchable. Bookkeeping after that
  // must not report it as failed, so a failure here is logged instead. Nothing retries or
  // reconciles a lost EMBEDDINGS record; today that metric is recorded but not read by any
  // limit, invoice or usage page.
  try {
    await recordUsage(orgId, "EMBEDDINGS", chunkCount, { documentId });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "document_embed_usage_failed",
        orgId,
        documentId,
        name: err instanceof Error ? err.name : "unknown",
      }),
    );
  }
  try {
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
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "document_ready_notification_failed",
        orgId,
        documentId,
        name: err instanceof Error ? err.name : "unknown",
      }),
    );
  }

  return NextResponse.json({ ok: true, chunks: chunkCount });
}
