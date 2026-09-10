import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { getCreatorCampaign }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-campaigns"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const { id } = await params;
    const campaign = await getCreatorCampaign(ctx, id);
    return NextResponse.json({ data: campaign });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
