import { NextResponse } from "next/server";
import { z } from "zod";
import { isTransientAiError } from "@/server/ai/retry";
import { jobPayloadJson, jobWillBeRetried } from "@/server/jobs/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const payloadSchema = z.object({
  documentId: z.string().guid(),
  orgId: z.string().guid(),
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
 * The stored file couldn't be downloaded. `transient` when the storage service
 * couldn't be reached or answered 408, 429 or 5xx; a missing object or a
 * refused request is not, since another delivery would get the same answer.
 */
class StorageDownloadError extends Error {
  override name = "StorageDownloadError";
  constructor(readonly transient: boolean) {
    super("Storage download failed");
  }
}

/** storage-js reports a failed request as `StorageUnknownError`, an HTTP answer with `status`. */
function isTransientStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "StorageUnknownError") return true;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

/**
 * What the pg driver adapter calls a failure another delivery may not hit:
 * database unreachable, socket timeout, connection closed, write conflict,
 * too many connections.
 */
const TRANSIENT_DRIVER_KINDS = new Set([
  "DatabaseNotReachable",
  "SocketTimeout",
  "ConnectionClosed",
  "TransactionWriteConflict",
  "TooManyConnections",
]);

/**
 * The codes Prisma gives those same driver failures on a model query. P2028
 * (transaction API error) is left out: nothing stable on the error tells
 * "couldn't start in time" from a transaction that expired, and an expiring
 * batch of chunk inserts would expire again on every delivery.
 */
const TRANSIENT_PRISMA_CODES = new Set(["P1001", "P1008", "P1017", "P2034", "P2037"]);

/**
 * A raw query (the chunk insert) reports every driver failure as P2010, with
 * the driver's own classification in `meta` (as in calendar/locks.ts). Only
 * the kinds above are transient; a statement Postgres rejected (kind
 * "postgres": invalid text, a vector of the wrong size) is not.
 */
function isTransientPrismaError(error: Error): boolean {
  const failure = error as {
    code?: unknown;
    errorCode?: unknown;
    meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
  };
  if (failure.code === "P2010") {
    const kind = failure.meta?.driverAdapterError?.cause?.kind;
    return typeof kind === "string" && TRANSIENT_DRIVER_KINDS.has(kind);
  }
  return [failure.code, failure.errorCode].some(
    (code) => typeof code === "string" && TRANSIENT_PRISMA_CODES.has(code),
  );
}

/**
 * Whether another delivery could succeed where this one failed. A retry
 * embeds the whole document again (a paid call) before it reaches the step
 * that failed, so only failures recognized here are retried: the storage
 * answers above, what the AI client already treats as transient (provider
 * 408/409/429/5xx, or a connection reset code), and the Prisma failures above.
 * An SDK wraps a network failure, so the error's causes are checked too.
 * Everything else -- a rejected insert, a refused request, a bug -- would fail
 * the same way every time, and is final on the first delivery.
 * Known miss: the provider client's request timeout carries no status, code or
 * cause, so it is final too (the owner uploads again).
 */
function isTransientFailure(err: unknown): boolean {
  if (err instanceof StorageDownloadError) return err.transient;
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (isTransientAiError(current) || isTransientPrismaError(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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

  const parsed = payloadSchema.safeParse(jobPayloadJson(rawBody));
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
      if (error || !data) throw new StorageDownloadError(isTransientStorageError(error));
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
      // Permanent: a retry finds the same row. The owner keeps seeing the generic text.
      throw new DocumentProcessingError(GENERIC_FAILURE);
    }

    // Postgres text and jsonb can't hold U+0000: left in (a note, a fetched
    // page or a parsed PDF can carry it), every chunk insert would be refused
    // after its embeddings were paid for.
    text = text.split("\u0000").join("");

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

    // Only the document this run claimed, if it still exists, becomes READY.
    // Deleted during the run (deleteDocument removed the chunks it knew of,
    // this run has since stored new ones): the new chunks go too, and
    // nothing is recorded or notified. match_chunks() already ignores a
    // deleted document's chunks; this keeps them from being stored at all.
    const ready = await unscopedPrisma.document.updateMany({
      where: { id: documentId, organizationId: orgId, deletedAt: null, status: "PROCESSING" },
      data: { status: "READY", chunkCount: chunks.length },
    });
    if (ready.count === 0) {
      await unscopedPrisma.documentChunk.deleteMany({ where: { documentId } });
      return NextResponse.json({ skipped: "document gone" });
    }
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
    // Retried only when storage, the provider or the database failed in a way
    // another delivery may not hit (isTransientFailure); never a failure with
    // an owner-facing cause. FAILED is claimable, and that run's deleteMany
    // replaces any chunks stored here. Usage is recorded only after READY, so
    // retries never count it twice. The owner hears about it only if the last
    // delivery fails too.
    if (message === GENERIC_FAILURE && isTransientFailure(err) && jobWillBeRetried(request)) {
      return NextResponse.json({ error: message }, { status: 500 });
    }
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
    // 200: permanent, or the last delivery; either way nothing more to retry
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
