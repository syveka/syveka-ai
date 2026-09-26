import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Authenticated preview of a completed IMAGE generation's stored output.
 * Authorizes the caller (creator:read in the active org + Creator Studio
 * flag), resolves the generation and its GENERATED asset inside that org,
 * then redirects to a one-minute signed URL for the private bucket. Every
 * response is private/no-store so neither browsers nor shared caches reuse
 * it across users or tenants. Read-only: never generates or touches credits.
 * The signed URL is never logged.
 */
const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie",
} as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [
    { requirePermission },
    { resolveGeneratedImage, signGeneratedImage, GeneratedImageError },
    { handleCreatorStudioError },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-generated-images"),
    import("@/server/services/creator-studio-http"),
  ]);
  try {
    const ctx = await requirePermission("creator:read");
    const { id } = await params;
    const { storagePath } = await resolveGeneratedImage(ctx, id);
    const signedUrl = await signGeneratedImage(storagePath);
    return NextResponse.redirect(signedUrl, { status: 302, headers: NO_STORE });
  } catch (e) {
    if (e instanceof GeneratedImageError) {
      return NextResponse.json(
        { error: { code: e.code === "invalid_id" ? "invalid_id" : "image_unavailable" } },
        { status: e.code === "invalid_id" ? 400 : 404, headers: NO_STORE },
      );
    }
    const res = handleCreatorStudioError(e);
    for (const [key, value] of Object.entries(NO_STORE)) res.headers.set(key, value);
    return res;
  }
}
