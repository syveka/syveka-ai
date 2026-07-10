import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { assertWithinLimit } from "./billing/entitlements";
import { enqueue } from "@/server/jobs/queue";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { CreateDocumentInput } from "@/lib/validators/documents";

const DOCUMENTS_BUCKET = "documents";

/** Signed upload URL — client uploads directly to Storage (§10.2). */
export async function createUploadUrl(
  ctx: TenantContext,
  params: { fileName: string; sizeBytes: number },
): Promise<{ storagePath: string; signedUrl: string; token: string }> {
  const db = tenantDb(ctx.orgId);
  const usedBytes = await db.document.aggregate({
    where: { deletedAt: null },
    _sum: { sizeBytes: true },
  });
  const currentMb = Math.ceil(((usedBytes._sum.sizeBytes ?? 0) + params.sizeBytes) / 1_048_576);
  await assertWithinLimit(ctx.orgId, { kind: "storage_mb", currentMb });

  const safeName = params.fileName.replace(/[^\w.\-äöåÄÖÅ ]+/g, "_").slice(0, 120);
  const storagePath = `${ctx.orgId}/${crypto.randomUUID()}/${safeName}`;

  const admin = createSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (error || !data) throw new Error(`Upload URL failed: ${error?.message}`);

  return { storagePath, signedUrl: data.signedUrl, token: data.token };
}

export async function createDocument(ctx: TenantContext, input: CreateDocumentInput) {
  const db = tenantDb(ctx.orgId);

  const document = await db.document.create({
    data: {
      organizationId: ctx.orgId,
      title: input.title,
      collectionId: input.collectionId,
      uploadedById: ctx.userId,
      sourceType: input.sourceType,
      storagePath: input.storagePath,
      sourceUrl: input.sourceUrl,
      mimeType:
        input.sourceType === "NOTE" ? "text/markdown" : input.mimeType,
      sizeBytes: input.sizeBytes ?? input.content?.length,
      status: "PENDING",
    },
  });

  // NOTE content is stored directly as the first "file": pass inline via job payload
  await enqueue("embed-document", {
    documentId: document.id,
    orgId: ctx.orgId,
    ...(input.sourceType === "NOTE" ? { inlineContent: input.content ?? "" } : {}),
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
      id: true, title: true, sourceType: true, status: true, error: true,
      chunkCount: true, sizeBytes: true, createdAt: true, mimeType: true,
    },
  });
}

export async function deleteDocument(ctx: TenantContext, documentId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const doc = await db.document.findFirstOrThrow({ where: { id: documentId } });

  await db.document.update({
    where: { id: documentId },
    data: { deletedAt: new Date() },
  });
  // chunks removed immediately so deleted content never surfaces in RAG
  await db.document.update({
    where: { id: documentId },
    data: { chunks: { deleteMany: {} }, chunkCount: 0 },
  });

  if (doc.storagePath) {
    const admin = createSupabaseAdmin();
    await admin.storage.from(DOCUMENTS_BUCKET).remove([doc.storagePath]).catch(() => undefined);
  }

  await audit(ctx, {
    action: "document.delete",
    resourceType: "document",
    resourceId: documentId,
    before: { title: doc.title },
  });
}
