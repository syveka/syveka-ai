import { NextResponse } from "next/server";
import { schedulePostSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [
    { requirePermission },
    { schedulePost },
    { handleCreatorStudioError },
    { rateLimitRefusal },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-posts"),
    import("@/server/services/creator-studio-http"),
    import("@/server/security/rate-limit"),
  ]);
  try {
    const ctx = await requirePermission("creator:publish");
    const refusal = await rateLimitRefusal("creatorPostWorkflow", `${ctx.orgId}:${ctx.userId}`);
    if (refusal) return refusal;
    const { id } = await params;
    const body = schedulePostSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const post = await schedulePost(ctx, id, body.data);
    return NextResponse.json({ data: post });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
