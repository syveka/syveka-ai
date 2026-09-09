import "server-only";

import { randomUUID } from "node:crypto";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { audit } from "./audit";
import { assertFeatureEnabled } from "./feature-flags";
import { slugify } from "@/lib/utils";
import type { TenantContext } from "@/server/auth/session";
import type { CreateCreatorProfileInput } from "@/lib/validators/creator-studio";
import { MIN_REFERENCE_ASSETS } from "@/lib/validators/creator-studio";
import {
  REFERENCE_ASSET_UPLOAD_INTENT_TTL_MS,
  verifyReferenceImageObject,
  type CreatorAssetMimeType,
} from "@/server/security/creator-asset-ingestion";
import {
  assertTenantStoragePath,
  validateUploadIntent,
  DocumentIngestionError,
} from "@/server/security/document-ingestion";

const REFERENCE_ASSETS_BUCKET = "creator-reference-assets";
export const CREATOR_STUDIO_FLAG = "creator_studio_v1";

export class CreatorProfileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function uniqueSlug(orgId: string, base: string): Promise<string> {
  const db = tenantDb(orgId);
  const root = slugify(base) || "creator";
  let candidate = root;
  let suffix = 1;
  while (await db.creatorProfile.findFirst({ where: { slug: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
  return candidate;
}

export async function createCreatorProfile(ctx: TenantContext, input: CreateCreatorProfileInput) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const slug = await uniqueSlug(ctx.orgId, input.displayName);
  const profile = await db.creatorProfile.create({
    data: {
      organizationId: ctx.orgId,
      displayName: input.displayName,
      description: input.description,
      slug,
      ownerUserId: ctx.userId,
      status: "DRAFT",
    },
  });
  await audit(ctx, {
    action: "creator.profile.create",
    resourceType: "creator_profile",
    resourceId: profile.id,
    after: { displayName: input.displayName },
  });
  return profile;
}

export async function listCreatorProfiles(ctx: TenantContext) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  return db.creatorProfile.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { referenceAssets: true, generations: true, posts: true } } },
  });
}

export async function getCreatorProfile(ctx: TenantContext, id: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  return db.creatorProfile.findFirstOrThrow({
    where: { id },
    include: { referenceAssets: { orderBy: { createdAt: "desc" } } },
  });
}

/** Step 4 (Phase 4): create a tenant/user-bound, expiring upload intent and its signed storage URL. */
export async function createReferenceAssetUploadUrl(
  ctx: TenantContext,
  profileId: string,
  params: { fileName: string; mimeType: CreatorAssetMimeType; sizeBytes: number },
): Promise<{ uploadIntentId: string; signedUrl: string; expiresAt: Date }> {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  await db.creatorProfile.findFirstOrThrow({ where: { id: profileId }, select: { id: true } });

  const safeName = params.fileName.replace(/[^\p{L}\w.\- ]+/gu, "_").slice(0, 120);
  const storagePath = `${ctx.orgId}/${profileId}/${randomUUID()}/${safeName}`;
  const expiresAt = new Date(Date.now() + REFERENCE_ASSET_UPLOAD_INTENT_TTL_MS);
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
    .from(REFERENCE_ASSETS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (error || !data) {
    await db.documentUploadIntent.delete({ where: { id: intent.id } }).catch(() => undefined);
    throw new Error(`Upload URL failed: ${error?.message}`);
  }

  return { uploadIntentId: intent.id, signedUrl: data.signedUrl, expiresAt };
}

/** Step 4 (Phase 4): download + MIME-verify the uploaded object, then persist the reference asset row. */
export async function confirmReferenceAsset(
  ctx: TenantContext,
  profileId: string,
  uploadIntentId: string,
) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const now = new Date();
  const intent = await unscopedPrisma.documentUploadIntent.findFirst({
    where: { id: uploadIntentId, organizationId: ctx.orgId, userId: ctx.userId },
  });
  if (!intent) {
    throw new DocumentIngestionError("invalid_upload_intent", "Upload intent is not valid");
  }
  validateUploadIntent(intent, { organizationId: ctx.orgId, userId: ctx.userId }, now);
  assertTenantStoragePath(ctx.orgId, intent.storagePath);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(REFERENCE_ASSETS_BUCKET)
    .download(intent.storagePath);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
  const objectBuffer = Buffer.from(await data.arrayBuffer());
  verifyReferenceImageObject(
    objectBuffer,
    data.type,
    intent.expectedMimeType as CreatorAssetMimeType,
    intent.maxSizeBytes,
  );

  const asset = await unscopedPrisma.$transaction(async (tx) => {
    const profile = await tx.creatorProfile.findFirst({
      where: { id: profileId, organizationId: ctx.orgId },
      select: { id: true },
    });
    if (!profile) throw new CreatorProfileError("not_found", "Creator profile not found");

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

    return tx.creatorReferenceAsset.create({
      data: {
        organizationId: ctx.orgId,
        creatorProfileId: profileId,
        storagePath: intent.storagePath,
        assetType: "reference_image",
        mimeType: intent.expectedMimeType,
        sizeBytes: objectBuffer.length,
        source: "UPLOAD",
        validationStatus: "APPROVED",
      },
    });
  });

  await audit(ctx, {
    action: "creator.reference_asset.create",
    resourceType: "creator_reference_asset",
    resourceId: asset.id,
    after: { creatorProfileId: profileId },
  });
  return asset;
}

/** Step 3 (Phase 4): explicit ownership/permission consent, required before a profile can generate content. */
export async function confirmCreatorConsent(ctx: TenantContext, profileId: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);
  const approvedAssets = await db.creatorReferenceAsset.count({
    where: { creatorProfileId: profileId, validationStatus: "APPROVED" },
  });
  if (approvedAssets < MIN_REFERENCE_ASSETS) {
    throw new CreatorProfileError(
      "insufficient_reference_assets",
      `At least ${MIN_REFERENCE_ASSETS} reference images are required before consent can be confirmed.`,
    );
  }

  const profile = await db.creatorProfile.update({
    where: { id: profileId },
    data: { consentConfirmedAt: new Date(), status: "ACTIVE" },
  });
  await audit(ctx, {
    action: "creator.profile.consent_confirmed",
    resourceType: "creator_profile",
    resourceId: profileId,
  });
  return profile;
}
