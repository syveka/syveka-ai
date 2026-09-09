import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { listCreatorTemplates }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-templates"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const category = new URL(request.url).searchParams.get("category") ?? undefined;
    const templates = await listCreatorTemplates(ctx, category);
    return NextResponse.json({ data: templates });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
