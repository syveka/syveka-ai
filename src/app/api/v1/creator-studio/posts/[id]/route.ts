import { NextResponse } from "next/server";
import { updatePostContentSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { getCreatorPost }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-posts"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const { id } = await params;
    const post = await getCreatorPost(ctx, id);
    return NextResponse.json({ data: post });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { updatePostContent }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-posts"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:write");
    const { id } = await params;
    const body = updatePostContentSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const post = await updatePostContent(ctx, id, body.data);
    return NextResponse.json({ data: post });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
