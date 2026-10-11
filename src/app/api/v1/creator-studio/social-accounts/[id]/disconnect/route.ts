import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [
    { requirePermission },
    { disconnectSocialAccount },
    { handleCreatorStudioError },
    { rateLimitRefusal },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-social-accounts"),
    import("@/server/services/creator-studio-http"),
    import("@/server/security/rate-limit"),
  ]);
  try {
    const ctx = await requirePermission("creator:manage-social-accounts");
    const refusal = await rateLimitRefusal("creatorPostWorkflow", `${ctx.orgId}:${ctx.userId}`);
    if (refusal) return refusal;
    const { id } = await params;
    const account = await disconnectSocialAccount(ctx, id);
    return NextResponse.json({ data: account });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
