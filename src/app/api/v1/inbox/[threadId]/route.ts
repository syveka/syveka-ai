import { NextResponse } from "next/server";

type Params = { params: Promise<{ threadId: string }> };

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { getThread }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/inbox"),
  ]);

  try {
    const { threadId } = await params;
    const ctx = await requirePermission("inbox:read");
    const thread = await getThread(ctx, threadId);
    if (!thread) {
      return NextResponse.json({ error: { code: "resource_not_found" } }, { status: 404 });
    }
    return NextResponse.json({ data: thread });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}
