import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { listGenerations }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-generations"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const params = new URL(request.url).searchParams;
    const generations = await listGenerations(ctx, {
      creatorProfileId: params.get("creatorProfileId") ?? undefined,
      generationType: (params.get("generationType") as never) ?? undefined,
    });
    return NextResponse.json({ data: generations });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
