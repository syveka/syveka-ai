import "server-only";

import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { assertWithinLimit } from "./billing/entitlements";
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

const DOCUMENTS_BUCKET = "documents";

/** Create a tenant/user-bound, expiring upload intent and its signed storage URL. */
export async function createUploadUrl(
  ctx: TenantContext,
  params: { fileName: string; mimeType: AllowedMimeType; sizeBytes: number },
): Promise<{ uploadIntentId: string; signedUrl: string; expiresAt: Date }> {
  const db = tenantDb(ctx.orgId);
  const usedBytes = await db.document.aggregate({
    where: { deletedAt: null },
    _sum: { sizeBytes: true },
  });
  const currentMb = Math.ceil(((usedBytes._sum.sizeBytes ?? 0) + params.sizeBytes) / 1_048_576);
  await assertWithinLimit(ctx.orgId, { kind: "storage_mb", currentMb });

  const safeName = params.fileName.replace(/[^\p{L}\w.\- ]+/gu, "_").slice(0, 120);
  const storagePath = `${ctx.orgId}/${crypto.randomUUID()}/${safeName}`;
  const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_MS);
  const intent = await db.documentUploadIntent.create({
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

    document = await unscopedPrisma.$transaction(async (tx) => {
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
    const db = tenantDb(ctx.orgId);
    document = await db.document.create({
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
  }

  await enqueue("embed-document", {
    documentId: document.id,
    orgId: ctx.orgId,
    ...(input.sourceType === "NOTE" ? { inlineContent: input.content } : {}),
  });

  await audit(ctx, {
    action: "document.create",
    resourceType: "document",
    resourceId: document.id,
    after: { title: input.title, sourceType: input.sourceType },
  });

  return document;
}

export async function listDocuments(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.document.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      sourceType: true,
      status: true,
      error: true,
      chunkCount: true,
      sizeBytes: true,
      createdAt: true,
      mimeType: true,
    },
  });
}

export async function deleteDocument(ctx: TenantContext, documentId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const doc = await db.document.findFirstOrThrow({ where: { id: documentId } });

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
