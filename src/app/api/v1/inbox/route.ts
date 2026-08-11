import { NextResponse } from "next/server";
import { threadListQuerySchema } from "@/lib/validators/inbox";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { listThreads }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/inbox"),
  ]);

  try {
    const ctx = await requirePermission("inbox:read");
    const query = threadListQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: query.error.flatten() } },
        { status: 400 },
      );
    }
    const result = await listThreads(ctx, query.data);
    return NextResponse.json({ data: result.data, nextCursor: result.nextCursor ?? null });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}
