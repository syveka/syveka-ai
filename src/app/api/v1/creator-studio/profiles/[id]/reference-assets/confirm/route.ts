import { NextResponse } from "next/server";
import { confirmReferenceAssetSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { confirmReferenceAsset }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-profiles"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:write");
    const { id } = await params;
    const body = confirmReferenceAssetSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const asset = await confirmReferenceAsset(ctx, id, body.data.uploadIntentId);
    return NextResponse.json({ data: asset }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
