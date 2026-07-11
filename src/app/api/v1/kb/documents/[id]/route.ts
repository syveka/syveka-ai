import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { tenantDb }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/db/tenant"),
  ]);

  try {
    const { id } = await params;
    const ctx = await requirePermission("kb:read");
    const document = await tenantDb(ctx.orgId).document.findFirst({
      where: { id, deletedAt: null },
    });
    if (!document) {
      return NextResponse.json({ error: { code: "resource_not_found" } }, { status: 404 });
    }
    return NextResponse.json({ data: document });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { deleteDocument }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/documents"),
  ]);

  try {
    const { id } = await params;
    const ctx = await requirePermission("kb:write");
    await deleteDocument(ctx, id);
    return NextResponse.json({ data: { deleted: true } });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}
