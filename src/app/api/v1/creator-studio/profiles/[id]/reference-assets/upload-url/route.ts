import { NextResponse } from "next/server";
import { referenceAssetUploadUrlSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [
    { requirePermission },
    { createReferenceAssetUploadUrl },
    { handleCreatorStudioError },
    { rateLimiters },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-profiles"),
    import("@/server/services/creator-studio-http"),
    import("@/server/integrations/redis"),
  ]);
  try {
    const ctx = await requirePermission("creator:write");
    const rateLimit = await rateLimiters.api.limit(
      `creator-reference-upload-url:${ctx.orgId}:${ctx.userId}`,
    );
    if (!rateLimit.success) {
      return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
    }
    const { id } = await params;
    const body = referenceAssetUploadUrlSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const result = await createReferenceAssetUploadUrl(ctx, id, body.data);
    return NextResponse.json({ data: result });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
