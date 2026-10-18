import { NextResponse } from "next/server";
import { createPostSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { listCreatorPosts }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-posts"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const params = new URL(request.url).searchParams;
    const posts = await listCreatorPosts(ctx, {
      campaignId: params.get("campaignId") ?? undefined,
      approvalStatus: params.get("approvalStatus") ?? undefined,
      publishStatus: params.get("publishStatus") ?? undefined,
      platform: (params.get("platform") as never) ?? undefined,
    });
    return NextResponse.json({ data: posts });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { createCreatorPost },
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
    const refused = await rateLimitRefusal(
      "api",
      `creator-posts-create:${ctx.orgId}:${ctx.userId}`,
    );
    if (refused) return refused;
    const body = createPostSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const post = await createCreatorPost(ctx, body.data);
    return NextResponse.json({ data: post }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
