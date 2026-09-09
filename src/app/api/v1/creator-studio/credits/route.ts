import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { getCreatorCreditBalance }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-credits"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const balance = await getCreatorCreditBalance(ctx);
    return NextResponse.json({ data: balance });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
