import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { listSocialAccounts }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-social-accounts"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const accounts = await listSocialAccounts(ctx);
    return NextResponse.json({ data: accounts });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
