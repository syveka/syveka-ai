import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { cancelScheduledPost }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-posts"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:publish");
    const { id } = await params;
    const post = await cancelScheduledPost(ctx, id);
    return NextResponse.json({ data: post });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
