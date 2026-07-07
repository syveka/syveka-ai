import { NextResponse } from "next/server";
import { requirePermission } from "@/server/auth/guard";
import { AuthError } from "@/server/auth/session";
import { tenantDb } from "@/server/db/tenant";
import { deleteDocument } from "@/server/services/documents";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
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
