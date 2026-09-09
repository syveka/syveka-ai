import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { getGeneration }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-generations"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const { id } = await params;
    const generation = await getGeneration(ctx, id);
    return NextResponse.json({ data: generation });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
