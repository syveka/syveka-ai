import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

const notFound = () =>
  NextResponse.json({ error: { code: "resource_not_found" } }, { status: 404 });

/**
 * One of the organization's documents, in the same shape as the list: never
 * the storage object path, only the sanitized processing error.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { getDocument }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/documents"),
  ]);

  try {
    const { id } = await params;
    const ctx = await requirePermission("kb:read");
    const document = await getDocument(ctx, id);
    if (!document) return notFound();
    return NextResponse.json({ data: document });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { deleteDocument, DocumentNotFoundError }] =
    await Promise.all([
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
    // Unknown, deleted, or another organization's: the same 404, never a 500.
    if (e instanceof DocumentNotFoundError) return notFound();
    throw e;
  }
}
