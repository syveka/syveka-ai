import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import type { TenantContext } from "@/server/auth/session";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";

/**
 * Read-only access to the stored output of a completed IMAGE generation, for
 * the Creator Studio preview. Authorization is entirely server-side and by
 * database relationship -- generated objects are stored as `<provider>/<uuid>`
 * without an organization prefix, so a path-prefix check is not possible:
 *   1. the generation is resolved through tenantDb(ctx.orgId) (own org only);
 *   2. the asset id must be that generation's output;
 *   3. the asset row is resolved in the same org and must be GENERATED;
 *   4. the bucket is fixed here and the stored path must match a strict shape.
 * Nothing from the client other than the generation id is used, and this
 * module never generates, reserves, commits or releases anything.
 */
export const GENERATED_MEDIA_BUCKET = "creator-generated-media";

/** Signed URLs for previews live one minute; each request signs afresh. */
export const PREVIEW_SIGNED_URL_TTL_SECONDS = 60;

/** Server-written object keys: `<provider>/<file>` or `<provider>/<kind>/<file>`, no traversal. */
const SAFE_STORAGE_PATH =
  /^[a-z][a-z0-9-]{0,31}\/(?:[a-z][a-z0-9-]{0,31}\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:jpe?g|png|webp)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GeneratedImageFailure =
  | "invalid_id"
  | "not_found"
  | "no_output"
  | "asset_missing"
  | "not_an_image"
  | "unavailable"
  | "invalid_path";

export class GeneratedImageError extends Error {
  constructor(public readonly code: GeneratedImageFailure) {
    super(`Generated image unavailable: ${code}`);
    this.name = "GeneratedImageError";
  }
}

export function isSafeGeneratedStoragePath(path: string): boolean {
  return SAFE_STORAGE_PATH.test(path) && !path.includes("..");
}

/** Resolves the stored object for a completed IMAGE generation in the caller's org. */
export async function resolveGeneratedImage(
  ctx: TenantContext,
  generationId: string,
): Promise<{ storagePath: string; mimeType: string }> {
  if (!UUID.test(generationId)) throw new GeneratedImageError("invalid_id");
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  const db = tenantDb(ctx.orgId);

  const generation = await db.creatorGeneration.findFirst({
    where: { id: generationId, status: "COMPLETED", generationType: "IMAGE" },
    select: { outputAssetIds: true },
  });
  if (!generation) throw new GeneratedImageError("not_found");
  const assetId = generation.outputAssetIds[0];
  if (!assetId) throw new GeneratedImageError("no_output");

  const asset = await db.creatorReferenceAsset.findFirst({
    where: { id: assetId, source: "GENERATED" },
    select: { storagePath: true, mimeType: true, sizeBytes: true },
  });
  if (!asset) throw new GeneratedImageError("asset_missing");
  if (!asset.mimeType.startsWith("image/")) throw new GeneratedImageError("not_an_image");
  // The mock provider records outputs without writing bytes (sizeBytes 0).
  if (asset.sizeBytes <= 0) throw new GeneratedImageError("unavailable");
  if (!isSafeGeneratedStoragePath(asset.storagePath)) throw new GeneratedImageError("invalid_path");
  return { storagePath: asset.storagePath, mimeType: asset.mimeType };
}

/** Short-lived signed URL for a resolved object; the bucket stays private. */
export async function signGeneratedImage(storagePath: string): Promise<string> {
  if (!isSafeGeneratedStoragePath(storagePath)) throw new GeneratedImageError("invalid_path");
  const { data, error } = await createSupabaseAdmin()
    .storage.from(GENERATED_MEDIA_BUCKET)
    .createSignedUrl(storagePath, PREVIEW_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new GeneratedImageError("unavailable");
  return data.signedUrl;
}
