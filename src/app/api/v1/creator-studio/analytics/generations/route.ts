import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { getCreatorGenerationAnalytics }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-analytics"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("analytics:view");
    const data = await getCreatorGenerationAnalytics(ctx);
    return NextResponse.json({ data });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
