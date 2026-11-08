import "server-only";

import type { Prisma } from "@/generated/prisma/client/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import {
  assertStorageWithinPlan,
  assertWithinLimit,
  EntitlementError,
  getEntitlements,
} from "./billing/entitlements";
import { enqueue } from "@/server/jobs/queue";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { CreateDocumentInput } from "@/lib/validators/documents";
import type { AllowedMimeType } from "@/server/security/document-ingestion";
import {
  DocumentIngestionError,
  UPLOAD_INTENT_TTL_MS,
  validateUploadIntent,
  verifyUploadObject,
} from "@/server/security/document-ingestion";
import { assertSupportedUrl, UrlIngestionError } from "@/server/security/url-ingestion";
import { isDocumentStalled } from "@/lib/knowledge/processing";

const DOCUMENTS_BUCKET = "documents";

async function assertCollectionInTenant(
  tx: Prisma.TransactionClient,
  organizationId: string,
  collectionId?: string,
): Promise<void> {
  if (!collectionId) return;
  const collection = await tx.collection.findFirst({
    where: { id: collectionId, organizationId },
    select: { id: true },
  });
  if (!collection) {
    throw new DocumentIngestionError(
      "invalid_collection",
      "Collection does not belong to the active organization",
    );
  }
}

type StorageUsageClient = Pick<Prisma.TransactionClient, "document" | "documentUploadIntent">;

/**
 * Bytes the knowledge base already uses: what is stored, plus what open
 * upload links may still add (a file is uploaded after its link is issued,
 * so a link requested later must not see space an earlier, not-yet-uploaded
 * link will fill). `exceptIntentId` is a link being turned into a document,
 * whose file the caller counts itself. Creator Studio reference-asset links
 * share the upload-intent table and are counted too while open (at most 10
 * minutes).
 */
async function storageBytesInUse(
  client: StorageUsageClient,
  organizationId: string,
  exceptIntentId?: string,
): Promise<number> {
  const [stored, reserved] = await Promise.all([
    client.document.aggregate({
      where: { organizationId, deletedAt: null },
      _sum: { sizeBytes: true },
    }),
    client.documentUploadIntent.aggregate({
      where: {
        organizationId,
        usedAt: null,
        expiresAt: { gt: new Date() },
        ...(exceptIntentId ? { id: { not: exceptIntentId } } : {}),
      },
      _sum: { maxSizeBytes: true },
    }),
  ]);
  return (stored._sum.sizeBytes ?? 0) + (reserved._sum.maxSizeBytes ?? 0);
}

const toMb = (bytes: number) => Math.ceil(bytes / 1_048_576);

/**
 * Refuses when adding `addBytes` would take the knowledge base past the
 * plan's storage.
 *
 * Not serialized: a note or URL created while an upload link is being issued
 * can each see the same free space (notes are small; URLs add nothing until
 * fetched). Only upload-link creation takes lockKnowledgeStorage.
 *
 * Never call this inside an interactive transaction: on an entitlements cache
 * miss, assertWithinLimit reads through the root client, and with the
 * runtime's single-connection pool (src/server/db/prisma.ts) that read would
 * wait for the connection the transaction holds until it times out.
 */
async function assertStorageAvailable(
  client: StorageUsageClient,
  organizationId: string,
  addBytes: number,
  exceptIntentId?: string,
): Promise<void> {
  const used = await storageBytesInUse(client, organizationId, exceptIntentId);
  await assertWithinLimit(organizationId, { kind: "storage_mb", currentMb: toMb(used + addBytes) });
}

/**
 * Serializes upload-link creation per organization, so links requested in
 * parallel can't each see the same free space. Namespaced key pair, like
 * business-dna-patch.ts's, so it can't collide with the (orgId, n) locks in
 * src/server/calendar/locks.ts or billing/seats.ts.
 */
async function lockKnowledgeStorage(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('kb_storage'), hashtext(${orgId}))`;
}

/** Create a tenant/user-bound, expiring upload intent and its signed storage URL. */
export async function createUploadUrl(
  ctx: TenantContext,
  params: { fileName: string; mimeType: AllowedMimeType; sizeBytes: number },
): Promise<{ uploadIntentId: string; signedUrl: string; expiresAt: Date }> {
  // Read before the transaction (see assertStorageAvailable); the check and
  // the link are then one serialized step per organization.
  const entitlements = await getEntitlements(ctx.orgId);
  const db = tenantDb(ctx.orgId);

  const safeName = params.fileName.replace(/[^\p{L}\w.\- ]+/gu, "_").slice(0, 120);
  const storagePath = `${ctx.orgId}/${crypto.randomUUID()}/${safeName}`;
  const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_MS);
  // Scoped by the explicit organizationId filters.
  const intent = await unscopedPrisma.$transaction(async (tx) => {
    await lockKnowledgeStorage(tx, ctx.orgId);
    const used = await storageBytesInUse(tx, ctx.orgId);
    assertStorageWithinPlan(entitlements, toMb(used + params.sizeBytes));
    return tx.documentUploadIntent.create({
      data: {
        organizationId: ctx.orgId,
        userId: ctx.userId,
        storagePath,
        expectedMimeType: params.mimeType,
        maxSizeBytes: params.sizeBytes,
        expiresAt,
      },
      select: { id: true },
    });
  });

  const admin = createSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (error || !data) {
    await db.documentUploadIntent.delete({ where: { id: intent.id } }).catch(() => undefined);
    throw new Error(`Upload URL failed: ${error?.message}`);
  }

  return { uploadIntentId: intent.id, signedUrl: data.signedUrl, expiresAt };
}

export async function createDocument(ctx: TenantContext, input: CreateDocumentInput) {
  let document;

  if (input.sourceType === "UPLOAD") {
    const now = new Date();
    const intent = await unscopedPrisma.documentUploadIntent.findFirst({
      where: { id: input.uploadIntentId, organizationId: ctx.orgId, userId: ctx.userId },
    });
    if (!intent) {
      throw new DocumentIngestionError("invalid_upload_intent", "Upload intent is not valid");
    }
    validateUploadIntent(intent, { organizationId: ctx.orgId, userId: ctx.userId }, now);

    const admin = createSupabaseAdmin();
    const { data, error } = await admin.storage.from(DOCUMENTS_BUCKET).download(intent.storagePath);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
    const objectBuffer = Buffer.from(await data.arrayBuffer());
    verifyUploadObject(
      objectBuffer,
      data.type,
      intent.expectedMimeType as AllowedMimeType,
      intent.maxSizeBytes,
    );

    // Before the transaction, never inside it: see assertStorageAvailable.
    try {
      await assertStorageAvailable(unscopedPrisma, ctx.orgId, objectBuffer.length, intent.id);
    } catch (error) {
      if (error instanceof EntitlementError) {
        // The file will never become a document: spend its link so it stops
        // reserving space, then delete the file -- only if this request spent
        // the link. If another request (a double submit) spent it first, that
        // request's document points at this file. Best-effort; the refusal is
        // the answer either way.
        const spent = await unscopedPrisma.documentUploadIntent
          .updateMany({
            where: { id: intent.id, organizationId: ctx.orgId, userId: ctx.userId, usedAt: null },
            data: { usedAt: now },
          })
          .catch(() => ({ count: 0 }));
        if (spent.count === 1) {
          await admin.storage
            .from(DOCUMENTS_BUCKET)
            .remove([intent.storagePath])
            .catch(() => undefined);
        }
      }
      throw error;
    }
    document = await unscopedPrisma.$transaction(async (tx) => {
      await assertCollectionInTenant(tx, ctx.orgId, input.collectionId);
      const consumed = await tx.documentUploadIntent.updateMany({
        where: {
          id: intent.id,
          organizationId: ctx.orgId,
          userId: ctx.userId,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new DocumentIngestionError(
          "reused_upload_intent",
          "Upload intent was already used or expired",
        );
      }
      return tx.document.create({
        data: {
          organizationId: ctx.orgId,
          title: input.title,
          collectionId: input.collectionId,
          uploadedById: ctx.userId,
          sourceType: "UPLOAD",
          storagePath: intent.storagePath,
          mimeType: intent.expectedMimeType,
          sizeBytes: objectBuffer.length,
          status: "PENDING",
        },
      });
    });
  } else {
    if (input.sourceType === "URL") assertSupportedUrl(input.sourceUrl);
    // A URL's size is unknown until it is fetched, so it adds nothing here; it
    // is still refused once storage is past the plan, or the org is read-only.
    const addBytes = input.sourceType === "NOTE" ? Buffer.byteLength(input.content, "utf8") : 0;
    await assertStorageAvailable(unscopedPrisma, ctx.orgId, addBytes);
    document = await unscopedPrisma.$transaction(async (tx) => {
      await assertCollectionInTenant(tx, ctx.orgId, input.collectionId);
      return tx.document.create({
        data: {
          organizationId: ctx.orgId,
          title: input.title,
          collectionId: input.collectionId,
          uploadedById: ctx.userId,
          sourceType: input.sourceType,
          sourceUrl: input.sourceType === "URL" ? input.sourceUrl : undefined,
          mimeType: input.sourceType === "NOTE" ? "text/markdown" : undefined,
          sizeBytes:
            input.sourceType === "NOTE" ? Buffer.byteLength(input.content, "utf8") : undefined,
          status: "PENDING",
        },
      });
    });
  }

  try {
    await enqueue("embed-document", {
      documentId: document.id,
      orgId: ctx.orgId,
      ...(input.sourceType === "NOTE" ? { inlineContent: input.content } : {}),
    });
  } catch (err) {
    // No job will run for it: say so rather than leave it "Pending" forever.
    await unscopedPrisma.document.update({
      where: { id: document.id },
      data: { status: "FAILED", error: "Processing could not be started. Please try again." },
    });
    throw err;
  }

  await audit(ctx, {
    action: "document.create",
    resourceType: "document",
    resourceId: document.id,
    after: { title: input.title, sourceType: input.sourceType },
  });

  return document;
}

/**
 * What a document looks like to its organization: never the storage object
 * path (an internal location) and only the sanitized processing error.
 */
const DOCUMENT_VIEW_SELECT = {
  id: true,
  title: true,
  sourceType: true,
  sourceUrl: true,
  status: true,
  error: true,
  chunkCount: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
  mimeType: true,
} as const;

type DocumentViewRow = Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_VIEW_SELECT }>;

/**
 * The document as shown to its organization (any row with at least the view's
 * fields): the view's fields only, plus `stalled` (still queued or processing
 * long after every retry of its job ran out).
 */
export function toDocumentView(row: DocumentViewRow, now: Date = new Date()) {
  const picked = Object.fromEntries(
    Object.keys(DOCUMENT_VIEW_SELECT).map((key) => [key, row[key as keyof DocumentViewRow]]),
  ) as DocumentViewRow;
  const { updatedAt, ...document } = picked;
  return {
    ...document,
    stalled: isDocumentStalled({ status: document.status, updatedAt }, now),
  };
}

const documentView = toDocumentView;

/**
 * The organization's documents. `stalled`: still queued or processing long after
 * every retry of its job ran out (see isDocumentStalled), so it will never finish.
 */
export async function listDocuments(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const documents = await db.document.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: DOCUMENT_VIEW_SELECT,
  });
  const now = new Date();
  return documents.map((document) => documentView(document, now));
}

/** One of the organization's documents, in the same shape as the list, or null. */
export async function getDocument(ctx: TenantContext, documentId: string) {
  const document = await tenantDb(ctx.orgId).document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: DOCUMENT_VIEW_SELECT,
  });
  return document ? documentView(document, new Date()) : null;
}

/** No such document in this organization (or already deleted). */
export class DocumentNotFoundError extends Error {
  constructor() {
    super("Document not found");
    this.name = "DocumentNotFoundError";
  }
}

export async function deleteDocument(ctx: TenantContext, documentId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  // Another organization's document is indistinguishable from an unknown id.
  const doc = await db.document.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!doc) throw new DocumentNotFoundError();

  await db.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
  await db.document.update({
    where: { id: documentId },
    data: { chunks: { deleteMany: {} }, chunkCount: 0 },
  });

  if (doc.storagePath) {
    const admin = createSupabaseAdmin();
    await admin.storage
      .from(DOCUMENTS_BUCKET)
      .remove([doc.storagePath])
      .catch(() => undefined);
  }

  await audit(ctx, {
    action: "document.delete",
    resourceType: "document",
    resourceId: documentId,
    before: { title: doc.title },
  });
}

export { DocumentIngestionError, UrlIngestionError };
