import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [
    { requirePermission },
    { requestPostApproval },
    { handleCreatorStudioError },
    { rateLimitRefusal },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-posts"),
    import("@/server/services/creator-studio-http"),
    import("@/server/security/rate-limit"),
  ]);
  try {
    const ctx = await requirePermission("creator:write");
    const refusal = await rateLimitRefusal("creatorPostWorkflow", `${ctx.orgId}:${ctx.userId}`);
    if (refusal) return refusal;
    const { id } = await params;
    const post = await requestPostApproval(ctx, id);
    return NextResponse.json({ data: post });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
